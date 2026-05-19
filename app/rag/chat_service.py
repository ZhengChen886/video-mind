from typing import List, Dict, Any, Optional, Callable
import re
from app.rag.vector_store import VectorStoreManager
from app.rag.prompts import SYSTEM_PROMPT, CONTEXT_TEMPLATE


class RAGChatService:
    def __init__(self, vector_store: VectorStoreManager = None):
        self.vector_store = vector_store or VectorStoreManager()
        self._doc_cache = {}

    def extract_doc_overview(self, content: str, doc_name: str = "") -> str:
        """从文档内容中提取概述"""
        if not content or not content.strip():
            return "无概述信息"

        overview_parts = []
        
        # 提取第一个标题或开头部分
        lines = content.strip().split('\n')
        
        # 尝试提取标题
        title_match = re.match(r'^#+\s*(.+)$', lines[0] if lines else '')
        if title_match:
            overview_parts.append(f"文档标题：{title_match.group(1)}")
        elif doc_name:
            overview_parts.append(f"文档名称：{doc_name}")
        
        # 提取前 500 字符作为概述
        overview_text = content[:800]
        if len(content) > 800:
            overview_text += "..."
        overview_parts.append(f"文档概要：{overview_text}")
        
        # 统计文档特征
        char_count = len(content)
        line_count = len(lines)
        overview_parts.append(f"文档规模：约 {char_count} 字符，{line_count} 行")
        
        # 提取所有主要标题（## 或 ### 级别）
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
        """构建文档信息展示"""
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

    def prepare_messages(
        self,
        question: str,
        history: List[Dict[str, str]] = None,
        n_results: int = 6,
        doc_id: str = None,
        doc_content: str = None,
        doc_name: str = ""
    ) -> Dict[str, Any]:
        chunks = self.vector_store.query(question, n_results=n_results, doc_id=doc_id)
        context = self.build_context(chunks)
        
        # 构建文档信息和概述
        doc_info = self.build_doc_info(doc_name, "md" if doc_name and doc_name.endswith('.md') else "txt")
        doc_overview = self.extract_doc_overview(doc_content or "", doc_name)
        
        # 对于较短的文档，直接包含完整内容
        full_content = ""
        if doc_content and len(doc_content) <= 3000:
            full_content = f"\n\n## 完整文档内容\n{doc_content}"
        
        system_message = SYSTEM_PROMPT.format(
            doc_info=doc_info,
            doc_overview=doc_overview,
            context=context + full_content
        )

        messages = [{"role": "system", "content": system_message}]

        if history:
            messages.extend(history[-20:])

        messages.append({"role": "user", "content": question})

        return {
            "messages": messages,
            "chunks": chunks,
            "context": context,
            "doc_overview": doc_overview
        }

    def index_document(
        self,
        doc_id: str,
        content: str,
        doc_type: str = "md"
    ) -> Dict[str, Any]:
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
