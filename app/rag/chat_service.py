"""
RAG 聊天服务 - 集成 Tool Calling 能力

支持：
1. 普通对话（无工具）
2. Tool Calling 对话（文档查询工具 + Web 搜索工具）
3. 自动注入文档内容到工具参数
"""

from typing import List, Dict, Any, Optional
import json
import logging

from app.rag.vector_store import VectorStoreManager
from app.rag.prompts import SYSTEM_PROMPT, CONTEXT_TEMPLATE
from app.tools.orchestrator import ToolOrchestrator
from app.tools.registry import registry

logger = logging.getLogger(__name__)


class RAGChatService:
    def __init__(self, vector_store: VectorStoreManager = None):
        self.vector_store = vector_store or VectorStoreManager()
        self._doc_cache = {}
        self.orchestrator = ToolOrchestrator(max_iterations=5)

    def extract_doc_overview(self, content: str, doc_name: str = "") -> str:
        """从文档内容中提取概述"""
        if not content or not content.strip():
            return "无概述信息"

        overview_parts = []
        
        lines = content.strip().split('\n')
        
        title_match = re.match(r'^#+\s*(.+)$', lines[0] if lines else '')
        if title_match:
            overview_parts.append(f"文档标题：{title_match.group(1)}")
        elif doc_name:
            overview_parts.append(f"文档名称：{doc_name}")
        
        overview_text = content[:800]
        if len(content) > 800:
            overview_text += "..."
        overview_parts.append(f"文档概要：{overview_text}")
        
        char_count = len(content)
        line_count = len(lines)
        overview_parts.append(f"文档规模：约 {char_count} 字符，{line_count} 行")
        
        main_sections = []
        for line in lines:
            section_match = re.match(r'^##+\s*(.+)$', line)
            if section_match:
                main_sections.append(section_match.group(1))
                if len(main_sections) >= 10:
                    break
        
        if main_sections:
            overview_parts.append(f"主要章节：{', '.join(main_sections)}")
        
        return "\n".join(overview_parts)

    def build_doc_info(self, doc_name: str = "", doc_type: str = "") -> str:
        info_parts = []
        if doc_name:
            info_parts.append(f"文档名称：{doc_name}")
        if doc_type:
            info_parts.append(f"文档类型：{doc_type}")
        return "\n".join(info_parts) if info_parts else "无文档信息"

    def build_context(self, chunks: List[Dict[str, Any]]) -> str:
        if not chunks:
            return "（未找到相关文档内容）"

        context_parts = []
        for i, chunk in enumerate(chunks, 1):
            doc_id = chunk.get("metadata", {}).get("doc_id", "unknown")
            chunk_index = chunk.get("metadata", {}).get("chunk_index", 0)
            text = chunk.get("text", "")

            context_parts.append(CONTEXT_TEMPLATE.format(
                doc_id=doc_id,
                chunk_index=chunk_index + 1,
                text=text
            ))

        return "\n".join(context_parts)

    def _build_tool_call_system_prompt(self, doc_info: str, doc_overview: str, context: str) -> str:
        """构建带 Tool Calling 的系统提示词"""
        tool_names = registry.list_tool_names()
        
        return f"""你是一个知识库问答助手。你可以：

1. **直接回答**：如果检索到的内容已经足够回答用户问题，直接给出准确答案
2. **调用工具**：如果需要更多细节、搜索互联网、或查找文档中的具体内容，使用下方提供的工具

## 文档信息
{doc_info}

## 文档概述  
{doc_overview}

## 检索到的相关文档内容
---
{context}
---

## 可用工具
{', '.join(tool_names)}

### 工具说明
- **lookup_text**：在当前文档中按关键词搜索文本段落，适合查找具体细节、引用原文
- **get_doc_info**：获取文档基本信息（字数、行数、章节结构等）
- **get_section_content**：获取某个章节的完整内容
- **web_search**：联网搜索最新信息，当问题涉及实时数据、外部知识时使用
- **web_fetch**：获取指定网页的详细正文内容

## 回答要求
1. 优先基于检索到的文档内容回答
2. 如果需要更多信息，主动调用合适的工具
3. 工具调用要精准，不要重复调用相同参数
4. 最终给用户简洁、准确的中文回答
5. 引用文档内容时要标注来源
6. 不要编造文档中没有的信息
7. 对于需要联网的问题（如新闻、天气、股价），主动使用 web_search
"""

    def prepare_messages(
        self,
        question: str,
        history: List[Dict[str, str]] = None,
        n_results: int = 6,
        doc_id: str = None,
        doc_content: str = None,
        doc_name: str = "",
        enable_tools: bool = True,
    ) -> Dict[str, Any]:
        """
        准备对话消息
        
        Args:
            enable_tools: 是否启用 Tool Calling（默认 True）
        """
        chunks = self.vector_store.query(question, n_results=n_results, doc_id=doc_id)
        context = self.build_context(chunks)
        
        doc_info = self.build_doc_info(doc_name, "md" if doc_name and doc_name.endswith('.md') else "txt")
        doc_overview = self.extract_doc_overview(doc_content or "", doc_name)
        
        full_content = ""
        if doc_content and len(doc_content) <= 3000:
            full_content = f"\n\n## 完整文档内容\n{doc_content}"
        
        # 根据是否启用工具选择不同的 system prompt
        if enable_tools and len(registry.get_all()) > 0:
            system_message = self._build_tool_call_system_prompt(
                doc_info=doc_info,
                doc_overview=doc_overview,
                context=context + full_content,
            )
        else:
            system_message = SYSTEM_PROMPT.format(
                doc_info=doc_info,
                doc_overview=doc_overview,
                context=context + full_content,
            )

        messages = [{"role": "system", "content": system_message}]

        if history:
            messages.extend(history[-20:])

        messages.append({"role": "user", "content": question})

        return {
            "messages": messages,
            "chunks": chunks,
            "context": context,
            "doc_overview": doc_overview,
            "doc_content": doc_content or "",
            "doc_name": doc_name,
            "enable_tools": enable_tools,
        }

    async def chat_with_tools(
        self,
        client,
        model: str,
        messages: List[Dict[str, Any]],
        doc_content: str = "",
        temperature: float = 0.7,
        max_tokens: int = 2000,
    ) -> str:
        """
        使用 Tool Calling 进行对话
        
        将自动注入文档内容到 lookup_text / get_doc_info / get_section_content 的参数中。
        """
        # 注入文档内容到工具调用参数（通过消息级指令告诉模型）
        if doc_content:
            # 在最后一条 user 消息前插入工具上下文注入
            tool_context_msg = {
                "role": "system",
                "content": f"[工具参数预填充] 当前文档内容已加载，字数约 {len(doc_content)} 字符。"
                           f"在调用 lookup_text、get_doc_info、get_section_content 时，"
                           f"doc_content 参数值为上述完整文档内容，无需重新获取。"
                           f"doc_name 参数值为当前打开的文档名。"
            }
            # 插入到 system 之后、user 之前
            messages.insert(-1, tool_context_msg)
        
        answer = await self.orchestrator.process_with_tools(
            client=client,
            model=model,
            messages=messages,
            tools=None,  # 使用注册表全部工具
            temperature=temperature,
            max_tokens=max_tokens,
        )
        
        return answer

    def index_document(self, doc_id: str, content: str, doc_type: str = "md") -> Dict[str, Any]:
        try:
            chunk_count = self.vector_store.index_document(
                doc_id,
                content,
                metadata={"type": doc_type}
            )
            return {
                "success": True,
                "indexed_chunks": chunk_count,
                "doc_id": doc_id
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }

    def check_index_status(self, doc_id: str) -> Dict[str, Any]:
        is_indexed = self.vector_store.is_indexed(doc_id)
        chunk_count = self.vector_store.get_indexed_chunks_count(doc_id) if is_indexed else 0

        return {
            "doc_id": doc_id,
            "is_indexed": is_indexed,
            "chunk_count": chunk_count
        }

    def delete_document_index(self, doc_id: str) -> bool:
        try:
            self.vector_store.delete_index(doc_id)
            return True
        except Exception:
            return False


# 需要在方法中使用 re
import re
