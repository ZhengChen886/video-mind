"""
内置知识库工具 - 文档查询类

提供文档内容检索、元信息获取等能力，供 LLM 通过 Tool Calling 调用。
"""

import re
from typing import Dict, Any, Optional, List
from app.tools.base_tool import BaseTool, ToolResult, ToolParameter
from app.tools.registry import register_tool


@register_tool
class LookupTextTool(BaseTool):
    """
    lookup_text - 在当前文档中按关键词搜索文本
    
    用于查找文档中包含特定关键词的段落，支持精确匹配和模糊搜索。
    """
    
    name = "lookup_text"
    description = """在当前文档中搜索包含指定关键词的文本段落。
当用户询问文档中的具体内容、细节或需要引用原文时使用此工具。
支持多个关键词同时搜索（用空格分隔）。"""
    
    parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="要搜索的关键词或查询文本",
            required=True,
        ),
        ToolParameter(
            name="doc_content",
            type="string",
            description="完整的文档内容（由系统自动注入）",
            required=False,
        ),
        ToolParameter(
            name="max_results",
            type="number",
            description="返回的最大结果数量，默认 5",
            default=5,
        ),
        ToolParameter(
            name="context_chars",
            type="number",
            description="每个匹配结果前后包含的上下文字符数，默认 100",
            default=100,
        ),
    ]
    
    async def execute(self, query: str, doc_content: str = "", max_results: int = 5, context_chars: int = 100) -> ToolResult:
        if not doc_content:
            return ToolResult(success=False, error="文档内容为空")
        
        if not query.strip():
            return ToolResult(success=False, error="搜索关键词不能为空")
        
        keywords = query.strip().split()
        lines = doc_content.split("\n")
        
        results = []
        for i, line in enumerate(lines):
            line_lower = line.lower()
            
            # 检查是否包含所有关键词
            if all(kw.lower() in line_lower for kw in keywords):
                # 提取上下文
                start = max(0, i - 2)
                end = min(len(lines), i + 3)
                context_lines = lines[start:end]
                context_text = "\n".join(context_lines)
                
                # 高亮匹配位置
                highlighted = self._highlight(line, keywords)
                
                results.append({
                    "line_number": i + 1,
                    "match": highlighted,
                    "context": context_text.strip(),
                })
                
                if len(results) >= max_results:
                    break
        
        if not results:
            return ToolResult(success=True, data={
                "found": False,
                "message": f"未找到包含 '{query}' 的内容",
                "results": [],
            })
        
        return ToolResult(success=True, data={
            "found": True,
            "query": query,
            "count": len(results),
            "results": results,
        })
    
    def _highlight(self, text: str, keywords: List[str]) -> str:
        """在文本中标记关键词"""
        result = text
        for kw in keywords:
            result = re.sub(
                f"({re.escape(kw)})",
                r"**\1**",
                result,
                flags=re.IGNORECASE
            )
        return result


@register_tool
class GetDocInfoTool(BaseTool):
    """
    get_doc_info - 获取当前文档的基本元信息
    
    返回文档的字数、行数、标题结构等统计信息。
    """
    
    name = "get_doc_info"
    description = """获取当前文档的基本信息，包括字数、行数、章节结构等。
当用户询问文档概况、有多大、有哪些章节时使用此工具。"""
    
    parameters = [
        ToolParameter(
            name="doc_content",
            type="string",
            description="完整文档内容（系统自动注入）",
            required=True,
        ),
        ToolParameter(
            name="doc_name",
            type="string",
            description="文档名称",
            required=False,
            default="",
        ),
    ]
    
    async def execute(self, doc_content: str, doc_name: str = "") -> ToolResult:
        if not doc_content:
            return ToolResult(success=False, error="文档内容为空")
        
        lines = doc_content.split("\n")
        char_count = len(doc_content)
        word_count = len(doc_content.replace("\n", "").replace(" ", ""))
        
        # 提取标题结构
        headings = []
        for line in lines:
            m = re.match(r'^(#{1,6})\s+(.+)$', line)
            if m:
                level = len(m.group(1))
                title = m.group(2).strip()
                headings.append({"level": level, "title": title})
        
        return ToolResult(success=True, data={
            "name": doc_name or "未知文档",
            "char_count": char_count,
            "word_count": word_count,
            "line_count": len(lines),
            "headings": headings[:50],  # 限制返回数量
            "heading_count": len(headings),
        })


@register_tool
class GetSectionContentTool(BaseTool):
    """
    get_section_content - 获取文档某个章节的完整内容
    
    按章节标题定位并提取该章节下的全部内容。
    """
    
    name = "get_section_content"
    description = """获取文档中指定章节的完整内容。
当用户要求查看某个具体章节、某部分详细内容时使用此工具。"""
    
    parameters = [
        ToolParameter(
            name="section_title",
            type="string",
            description="要获取内容的章节标题（支持模糊匹配）",
            required=True,
        ),
        ToolParameter(
            name="doc_content",
            type="string",
            description="完整文档内容（系统自动注入）",
            required=True,
        ),
    ]
    
    async def execute(self, section_title: str, doc_content: str) -> ToolResult:
        if not doc_content:
            return ToolResult(success=False, error="文档内容为空")
        
        lines = doc_content.split("\n")
        
        # 找到目标章节
        start_idx = None
        end_idx = len(lines)
        target_level = None
        
        for i, line in enumerate(lines):
            m = re.match(r'^(#{1,6})\s+(.+)$', line)
            if m:
                level = len(m.group(1))
                title = m.group(2).strip()
                
                # 模糊匹配目标章节
                if start_idx is None and section_title.lower() in title.lower():
                    start_idx = i
                    target_level = level
                    continue
                
                # 找到了目标章节后的同级或更高级标题 → 章节结束
                if start_idx is not None and level <= target_level:
                    end_idx = i
                    break
        
        if start_idx is None:
            return ToolResult(success=True, data={
                "found": False,
                "message": f"未找到标题包含 '{section_title}' 的章节",
                "similar_sections": self._find_similar_sections(section_title, lines),
            })
        
        section_lines = lines[start_idx:end_idx]
        content = "\n".join(section_lines).strip()
        
        return ToolResult(success=True, data={
            "found": True,
            "section_title": section_title,
            "content": content,
            "line_range": (start_idx + 1, end_idx),
        })
    
    def _find_similar_sections(self, query: str, lines: List[str]) -> List[str]:
        """找相似章节名作为建议"""
        sections = []
        for line in lines:
            m = re.match(r'^#{1,6}\s+(.+)$', line)
            if m:
                sections.append(m.group(1).strip())
        return sections[:10]
