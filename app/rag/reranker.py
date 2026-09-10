"""
Reranker 二次排序模块

工作流程：向量检索（Bi-Encoder）快速召回 top-K 候选
        -> Reranker（CrossEncoder）对 (query, candidate) 逐一精排
        -> 取 top-N 最终结果

降级方案：FallbackReranker 基于关键词重叠度打分，
在 CrossEncoder 模型加载失败时自动启用，保证服务不中断。
"""

import json
import logging
import os
import re
import threading
# 如果项目里还有 embedding_model.py，请改为相对导入：from . import embedding_model
from pathlib import Path
from typing import List, Dict, Any, Optional

from app.config.paths import CONFIG_DIR

logger = logging.getLogger(__name__)

# 从 config/app_paths.json 读取模型配置
# 使用 app/config/paths.py 统一的项目根目录计算，避免硬编码依赖文件层级
_PATHS_JSON = CONFIG_DIR / "app_paths.json"
DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"
RERANKER_CACHE_DIR = None
if _PATHS_JSON.is_file():
    _cfg = json.loads(_PATHS_JSON.read_text(encoding="utf-8"))
    _rag_cfg = _cfg.get("rag") or {}
    _reranker_model = _rag_cfg.get("reranker_model")
    _reranker_cache = _rag_cfg.get("reranker_cache_dir")
    # config 里的 reranker_model 已经是精确路径（包含 config.json 等权重），
    # 直接作为 from_pretrained 的入口使用。
    if _reranker_model:
        DEFAULT_RERANKER_MODEL = _reranker_model
    RERANKER_CACHE_DIR = _reranker_cache
    # 启用离线模式，避免 transformers 误去 HuggingFace 联网校验/下载
    if RERANKER_CACHE_DIR and Path(RERANKER_CACHE_DIR).is_dir():
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HOME", str(Path(RERANKER_CACHE_DIR).parent))
        logger.info(f"Reranker 使用本地模型路径: {RERANKER_CACHE_DIR}")
    else:
        logger.warning(
            f"Reranker 本地路径不存在，将回退到 HF 模型 ID: {DEFAULT_RERANKER_MODEL}"
        )


class BaseReranker:
    """Reranker 基类"""

    name: str = "base"

    def rerank(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
        top_n: int = 6
    ) -> List[Dict[str, Any]]:
        raise NotImplementedError


class FallbackReranker(BaseReranker):
    """
    降级 Reranker：基于关键词重叠度打分

    实现：
    1. 中英文分词（英文按单词、中文按 2-gram）
    2. 计算 query 与 candidate 的关键词重叠率作为相关度分数
    3. 分数附加到 candidate 的 metadata.rerank_score
    """

    name = "fallback"

    @staticmethod
    def _tokenize(text: str) -> set:
        """简易分词：英文单词 + 中文 2-gram"""
        if not text:
            return set()

        tokens = set()
        # 英文/数字单词
        for word in re.findall(r'[a-zA-Z0-9]+', text.lower()):
            if len(word) >= 2:
                tokens.add(word)

        # 中文 2-gram
        chinese_chars = re.findall(r'[\u4e00-\u9fff]', text)
        for i in range(len(chinese_chars) - 1):
            tokens.add(chinese_chars[i] + chinese_chars[i + 1])
        # 单字也加入（中文单字有较强语义）
        for ch in chinese_chars:
            tokens.add(ch)

        return tokens

    def rerank(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
        top_n: int = 6
    ) -> List[Dict[str, Any]]:
        if not candidates:
            return []

        query_tokens = self._tokenize(query)
        if not query_tokens:
            return candidates[:top_n]

        scored = []
        for cand in candidates:
            cand_tokens = self._tokenize(cand.get("text", ""))
            if cand_tokens:
                overlap = len(query_tokens & cand_tokens)
                score = overlap / len(query_tokens)
            else:
                score = 0.0

            item = dict(cand)
            item["rerank_score"] = round(score, 4)
            item["reranker"] = self.name
            scored.append(item)

        scored.sort(key=lambda x: x["rerank_score"], reverse=True)
        return scored[:top_n]


class CrossEncoderReranker(BaseReranker):
    """
    CrossEncoder Reranker：将 query 和 candidate 拼接后联合编码，语义匹配更精准

    基于 transformers 直接实现（AutoTokenizer + AutoModelForSequenceClassification），
    不依赖 sentence-transformers：其导入链（sklearn -> pandas -> pyarrow）
    在部分 Windows 环境下会触发原生 DLL 崩溃，且无法被 try/except 捕获。

    首次使用时会从 HuggingFace 自动下载模型（约 1.1GB）。
    如果网络不通，可提前下载后放到本地路径，
    修改 DEFAULT_RERANKER_MODEL 或初始化参数 model_name 为本地路径即可。
    """

    name = "cross-encoder"

    def __init__(self, model_name: str = DEFAULT_RERANKER_MODEL, max_length: int = 512):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self._torch = torch
        self.model_name = model_name
        self.max_length = max_length
        self.tokenizer = AutoTokenizer.from_pretrained(model_name)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_name)
        self.model.eval()
        logger.info(f"CrossEncoder Reranker 已加载: {model_name}")

    def rerank(
        self,
        query: str,
        candidates: List[Dict[str, Any]],
        top_n: int = 6
    ) -> List[Dict[str, Any]]:
        if not candidates:
            return []

        pairs = [[query, cand.get("text", "")] for cand in candidates]
        with self._torch.no_grad():
            inputs = self.tokenizer(
                pairs,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt",
            )
            logits = self.model(**inputs).logits
            # 单 logit 回归模型（bge-reranker 系列）：值越大越相关；
            # 多分类模型则取正类概率
            if logits.dim() == 2 and logits.size(-1) == 1:
                scores = logits.squeeze(-1)
            else:
                scores = self._torch.softmax(logits, dim=-1)[:, 1]
            scores = scores.tolist()

        scored = []
        for cand, score in zip(candidates, scores):
            item = dict(cand)
            item["rerank_score"] = round(float(score), 4)
            item["reranker"] = self.name
            scored.append(item)

        scored.sort(key=lambda x: x["rerank_score"], reverse=True)
        return scored[:top_n]


# 全局单例缓存：避免重复加载模型
_reranker_instance: Optional[BaseReranker] = None
_reranker_initialized = False
_reranker_lock = threading.Lock()


def get_reranker(model_name: str = DEFAULT_RERANKER_MODEL) -> BaseReranker:
    """
    获取 Reranker 实例（单例，双重检查锁定确保并发安全）

    优先加载 CrossEncoder；加载失败（未安装 torch/transformers /
    模型下载失败等）时自动降级为 FallbackReranker，保证服务不中断。
    """
    global _reranker_instance, _reranker_initialized

    # 第一次检查（无锁，快速路径）
    if _reranker_initialized:
        return _reranker_instance

    # 加锁，防止多线程首次并发时重复加载
    with _reranker_lock:
        # 第二次检查（锁内，防止其他线程已完成初始化）
        if _reranker_initialized:
            return _reranker_instance

        try:
            _reranker_instance = CrossEncoderReranker(model_name)
        except Exception as e:
            logger.warning(
                f"CrossEncoder Reranker 加载失败，降级为关键词重叠度打分: {e}"
            )
            _reranker_instance = FallbackReranker()

        _reranker_initialized = True
        return _reranker_instance


def reset_reranker():
    """重置单例（测试用）"""
    global _reranker_instance, _reranker_initialized
    with _reranker_lock:
        _reranker_instance = None
        _reranker_initialized = False
