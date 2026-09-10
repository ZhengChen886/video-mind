import json
import os
import re
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional
import logging

import chromadb
from chromadb.config import Settings

from app.config.paths import CONFIG_DIR

logger = logging.getLogger(__name__)

# 从 config/app_paths.json 读取 embedding 模型配置
# 使用 app/config/paths.py 统一的项目根目录计算，避免硬编码依赖文件层级
_PATHS_JSON = CONFIG_DIR / "app_paths.json"
EMBEDDING_MODEL = "chromadb/default_embeds"  # ChromaDB 默认 embedding 的标识
EMBEDDING_CACHE_DIR: Optional[str] = None
if _PATHS_JSON.is_file():
    _cfg = json.loads(_PATHS_JSON.read_text(encoding="utf-8"))
    _rag_cfg = _cfg.get("rag") or {}
    _embed_model = _rag_cfg.get("embedding_model")
    _embed_cache = _rag_cfg.get("embedding_cache_dir")
    if _embed_model:
        EMBEDDING_MODEL = _embed_model
    if _embed_cache:
        EMBEDDING_CACHE_DIR = _embed_cache
        Path(EMBEDDING_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        # 让 sentence-transformers 把缓存写到本地模型目录
        os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(Path(EMBEDDING_CACHE_DIR).parent))
        os.environ.setdefault("HF_HOME", str(Path(EMBEDDING_CACHE_DIR).parent))
        logger.info(f"Embedding 缓存目录：{EMBEDDING_CACHE_DIR}")


def _build_embedding_function():
    """
    构建 ChromaDB 兼容的 embedding 函数（基于 transformers 本地模型）

    - 模型路径：优先从 config/app_paths.json 读取（精确到含 config.json 的目录）
    - 实现：AutoTokenizer + AutoModel + mean pooling + L2 归一化，
      与 sentence-transformers/all-MiniLM-L6-v2 默认行为一致
    - 缺失依赖或加载失败：返回 None，由调用方降级到 ChromaDB 默认 embedding
    """
    try:
        from chromadb.utils import embedding_functions
    except Exception as e:
        logger.warning(f"ChromaDB embedding_functions 不可用，降级默认 embedding: {e}")
        return None

    model_path = EMBEDDING_MODEL
    is_local_dir = Path(model_path).is_dir() if model_path else False
    if not is_local_dir:
        logger.warning(
            f"Embedding 路径不是本地目录，将回退到 ChromaDB 默认 embedding: {model_path}"
        )
        return None

    # 检查本地目录是否含必需文件（避免 transformers 静默下载）
    required_files = ["config.json", "tokenizer.json", "vocab.txt"]
    has_safetensors = (Path(model_path) / "model.safetensors").is_file()
    has_pytorch = (Path(model_path) / "pytorch_model.bin").is_file()
    missing = [f for f in required_files if not (Path(model_path) / f).is_file()]
    if missing or not (has_safetensors or has_pytorch):
        logger.warning(
            f"Embedding 本地目录缺少权重/tokenizer文件: missing={missing} "
            f"safetensors={has_safetensors} pytorch={has_pytorch}, 降级默认 embedding"
        )
        return None

    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except Exception as e:
        logger.warning(
            f"transformers/torch 未安装或加载失败，降级默认 embedding: {e}"
        )
        return None

    try:
        tokenizer = AutoTokenizer.from_pretrained(model_path)
        model = AutoModel.from_pretrained(model_path)
        model.eval()
        logger.info(f"Embedding 模型已加载: {model_path}")
    except Exception as e:
        logger.warning(
            f"transformers 加载本地 embedding 模型失败，降级默认 embedding: {e}"
        )
        return None

    def _mean_pooling(last_hidden_state: "torch.Tensor", attention_mask: "torch.Tensor") -> "torch.Tensor":
        # 屏蔽 padding 位置后取均值（与 sentence-transformers 实现一致）
        mask = attention_mask.unsqueeze(-1).type_as(last_hidden_state)
        summed = (last_hidden_state * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1e-9)
        return summed / counts

    class _LocalEmbeddingFunction(embedding_functions.EmbeddingFunction):
        def __call__(self, input):  # type: ignore[override]
            texts = list(input)
            with torch.no_grad():
                encoded = tokenizer(
                    texts,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                )
                outputs = model(**encoded)
                pooled = _mean_pooling(outputs.last_hidden_state, encoded["attention_mask"])
                # L2 归一化（与 all-MiniLM-L6-v2 sentence-transformers 默认一致）
                pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
            return pooled.cpu().tolist()

    return _LocalEmbeddingFunction()


class VectorStoreManager:
    def __init__(self, persist_dir: str = "vector_db"):
        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)

        self.client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=Settings(anonymized_telemetry=False)
        )

        # 显式注入本地 embedding 函数（失败则回退 ChromaDB 默认）
        embedding_fn = _build_embedding_function()
        if embedding_fn is not None:
            self.embedding_fn = embedding_fn
        else:
            self.embedding_fn = None

        self.collection = self._open_or_recreate_collection(
            name="knowledge_base",
            embedding_fn=self.embedding_fn,
            metadata={"description": "Knowledge base vector store"},
        )

        self._embedding_cache = {}

    def _collection_has_data(self) -> bool:
        """判断 knowledge_base collection 里是否已经有真实数据"""
        try:
            existing = self.collection.get()
            ids = existing.get("ids") or []
            return len(ids) > 0
        except Exception as e:
            logger.debug(f"探测 collection 数据量失败: {e}")
            return False

    def _open_or_recreate_collection(self, name: str, embedding_fn, metadata):
        """
        打开/创建 collection；如果 embedding function 与已持久化的冲突：

        - 已持久化为本地 embedding + 当前也想用本地 embedding：直接 get
        - 已持久化为 default embedding（ChromaDB 默认） + 当前用本地 embedding：
            若 collection 为空 → 删了重建（知识库首次切换到本地 embedding 安全）
            若 collection 非空 → 抛 ValueError，提示用户备份后删除 vector_db
        """
        try:
            kwargs = {"name": name, "metadata": metadata}
            if embedding_fn is not None:
                kwargs["embedding_function"] = embedding_fn
            return self.client.get_or_create_collection(**kwargs)
        except ValueError as e:
            msg = str(e)
            is_embedding_conflict = "Embedding function conflict" in msg
            if not is_embedding_conflict:
                raise

            if embedding_fn is None:
                # 当前想用默认函数，但 collection 是别的 embedding 持久化出来的；
                # 同样需要数据为空才安全重建
                logger.warning(
                    "现有 collection 与当前默认 embedding 不一致，按空集合处理以重建"
                )

            if self._collection_has_data():
                logger.error(
                    "Embedding function 与已持久化 collection 冲突，且 collection 中已有数据。"
                    " 为避免历史索引错乱，本次不重建。请先备份并删除 vector_db 目录后重启："
                    f" {self.persist_dir}"
                )
                raise

            logger.warning(
                "检测到旧 collection 使用了不同的 embedding 函数（且无数据），将自动重建"
            )
            try:
                self.client.delete_collection(name=name)
            except Exception as del_err:
                logger.warning(f"删除旧 collection 失败: {del_err}")

            kwargs = {"name": name, "metadata": metadata}
            if embedding_fn is not None:
                kwargs["embedding_function"] = embedding_fn
            return self.client.get_or_create_collection(**kwargs)

    def _generate_doc_id(self, doc_id: str, chunk_index: int) -> str:
        content = f"{doc_id}_{chunk_index}"
        return hashlib.md5(content.encode()).hexdigest()

    def _chunk_markdown(self, text: str, doc_id: str, max_chunk_size: int = 800) -> List[Dict[str, Any]]:
        """
        按 Markdown 标题分块，同时限制单个 chunk 最大字符数
        
        如果某个 section 超过 max_chunk_size，会按段落进一步拆分
        """
        sections = re.split(r'(?=^#{2,3}\s)', text, flags=re.MULTILINE)
        chunks = []

        for i, section in enumerate(sections):
            section = section.strip()
            if not section:
                continue

            header_match = re.match(r'^(#{2,3})\s+(.+)$', section, re.MULTILINE)
            if header_match:
                level = len(header_match.group(1))
                title = header_match.group(2).strip()
                content = section[len(header_match.group(0)):].strip()
                chunk_text = f"{title}\n{content}" if content else title
            else:
                chunk_text = section

            if len(chunk_text) < 10:
                continue

            # 如果单个 chunk 超过最大限制，复用段落分块逻辑进一步拆分
            if len(chunk_text) > max_chunk_size:
                prefix = ""
                split_content = content if header_match else section
                if header_match:
                    prefix = f"{title}\n"

                sub_chunks = self._chunk_by_paragraph(
                    split_content, doc_id,
                    chunk_size=max_chunk_size, max_chunk_size=max_chunk_size
                )
                # 为每个子 chunk 补充标题前缀
                for sub in sub_chunks:
                    final_text = f"{prefix}{sub['text']}" if prefix else sub['text']
                    chunks.append({
                        "text": final_text,
                        "metadata": {
                            "doc_id": doc_id,
                            "chunk_index": len(chunks),
                            "chunk_type": "header",
                            "char_count": len(final_text)
                        }
                    })
            else:
                chunks.append({
                    "text": chunk_text,
                    "metadata": {
                        "doc_id": doc_id,
                        "chunk_index": len(chunks),
                        "chunk_type": "header",
                        "char_count": len(chunk_text)
                    }
                })

        return chunks

    def _chunk_by_paragraph(self, text: str, doc_id: str, chunk_size: int = 500, max_chunk_size: int = 800) -> List[Dict[str, Any]]:
        """
        按段落分块，同时限制单个 chunk 最大字符数
        
        如果某个段落组合超过 max_chunk_size，会强制拆分
        """
        paragraphs = re.split(r'\n\n+', text)
        chunks = []
        current_chunk = []
        current_length = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            para_length = len(para)

            # 如果单个段落本身就超过 max_chunk_size，需要强制拆分
            if para_length > max_chunk_size:
                # 先保存当前 chunk
                if current_chunk:
                    chunks.append({
                        "text": "\n\n".join(current_chunk),
                        "metadata": {
                            "doc_id": doc_id,
                            "chunk_index": len(chunks),
                            "chunk_type": "paragraph",
                            "char_count": sum(len(p) for p in current_chunk)
                        }
                    })
                    current_chunk = []
                    current_length = 0
                
                # 强制拆分超长段落
                for start in range(0, para_length, max_chunk_size):
                    sub_para = para[start:start + max_chunk_size]
                    chunks.append({
                        "text": sub_para,
                        "metadata": {
                            "doc_id": doc_id,
                            "chunk_index": len(chunks),
                            "chunk_type": "paragraph",
                            "char_count": len(sub_para)
                        }
                    })
                continue

            if current_length + para_length > chunk_size and current_chunk:
                chunks.append({
                    "text": "\n\n".join(current_chunk),
                    "metadata": {
                        "doc_id": doc_id,
                        "chunk_index": len(chunks),
                        "chunk_type": "paragraph",
                        "char_count": sum(len(p) for p in current_chunk)
                    }
                })
                current_chunk = []
                current_length = 0

            current_chunk.append(para)
            current_length += para_length

        if current_chunk:
            chunks.append({
                "text": "\n\n".join(current_chunk),
                "metadata": {
                    "doc_id": doc_id,
                    "chunk_index": len(chunks),
                    "chunk_type": "paragraph",
                    "char_count": sum(len(p) for p in current_chunk)
                }
            })

        return chunks

    def index_document(self, doc_id: str, content: str, metadata: Dict[str, Any] = None) -> int:
        self.delete_index(doc_id)

        file_ext = metadata.get("type", "txt") if metadata else "txt"

        if file_ext == "md":
            chunks = self._chunk_markdown(content, doc_id)
        else:
            chunks = self._chunk_by_paragraph(content, doc_id)

        if not chunks:
            return 0

        ids = [self._generate_doc_id(doc_id, i) for i in range(len(chunks))]
        texts = [chunk["text"] for chunk in chunks]
        metadatas = [chunk["metadata"] for chunk in chunks]

        self.collection.add(
            ids=ids,
            documents=texts,
            metadatas=metadatas
        )

        return len(chunks)

    def query(
        self,
        text: str,
        n_results: int = 6,
        doc_id: str = None,
        doc_ids: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        # 构造过滤条件：单文档 / 多文档（$in 一次查询）/ 全库
        if doc_ids:
            where_filter = {"doc_id": {"$in": list(doc_ids)}}
        elif doc_id:
            where_filter = {"doc_id": doc_id}
        else:
            where_filter = None

        results = self.collection.query(
            query_texts=[text],
            n_results=n_results,
            where=where_filter
        )

        if not results or not results.get("documents") or not results["documents"][0]:
            return []

        chunks = []
        for i, doc in enumerate(results["documents"][0]):
            chunk = {
                "text": doc,
                "distance": results["distances"][0][i] if results.get("distances") else 0,
                "metadata": results["metadatas"][0][i] if results.get("metadatas") else {}
            }
            chunks.append(chunk)

        return chunks

    def is_indexed(self, doc_id: str) -> bool:
        results = self.collection.get(
            where={"doc_id": doc_id},
            limit=1
        )
        return len(results.get("ids", [])) > 0

    def get_indexed_chunks_count(self, doc_id: str) -> int:
        results = self.collection.get(
            where={"doc_id": doc_id}
        )
        return len(results.get("ids", []))

    def delete_index(self, doc_id: str):
        try:
            existing = self.collection.get(where={"doc_id": doc_id})
            if existing and existing.get("ids"):
                self.collection.delete(ids=existing["ids"])
        except Exception:
            pass

    def get_all_indexed_docs(self) -> List[str]:
        try:
            all_data = self.collection.get()
            doc_ids = set()
            for meta in all_data.get("metadatas", []):
                if meta and "doc_id" in meta:
                    doc_ids.add(meta["doc_id"])
            return list(doc_ids)
        except Exception:
            return []

    def clear_all(self):
        try:
            self.client.delete_collection(name="knowledge_base")
            self.collection = self.client.get_or_create_collection(
                name="knowledge_base",
                metadata={"description": "Knowledge base vector store"}
            )
        except Exception:
            pass
