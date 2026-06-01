"""
Web 搜索工具 - 提供联网搜索能力

支持多种搜索引擎后端，默认使用 DuckDuckGo（无需 API Key）。
可通过配置切换到其他搜索引擎。
"""

import logging
import json
from typing import Dict, Any, Optional, List
from app.tools.base_tool import BaseTool, ToolResult, ToolParameter
from app.tools.registry import register_tool

logger = logging.getLogger(__name__)


class WebSearchEngine:
    """搜索引擎抽象层"""
    
    async def search(self, query: str, num_results: int = 5) -> List[Dict[str, Any]]:
        raise NotImplementedError


class DuckDuckGoSearchEngine(WebSearchEngine):
    """DuckDuckGo 搜索（无需 API Key，免费）"""
    
    async def search(self, query: str, num_results: int = 5) -> List[Dict[str, Any]]:
        try:
            import aiohttp
        except ImportError:
            # fallback to synchronous requests
            return self._sync_search(query, num_results)
        
        url = "https://html.duckduckgo.com/html/"
        data = {"q": query, "b": ""}
        
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        
        try:
            import aiohttp
            async with aiohttp.ClientSession() as session:
                async with session.post(url, data=data, headers=headers, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    html = await resp.text()
            
            return self._parse_ddg_html(html, num_results)
        except Exception as e:
            logger.error(f"DuckDuckGo 搜索失败: {e}")
            return self._sync_search(query, num_results)
    
    def _sync_search(self, query: str, num_results: int = 5) -> List[Dict[str, Any]]:
        """同步 fallback"""
        import urllib.request
        import urllib.parse
        
        url = "https://html.duckduckgo.com/html/"
        data = urllib.parse.urlencode({"q": query, "b": ""}).encode()
        
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        )
        
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            return self._parse_ddg_html(html, num_results)
        except Exception as e:
            logger.error(f"DuckDuckGo 同步搜索失败: {e}")
            return []
    
    def _parse_ddg_html(self, html: str, num_results: int) -> List[Dict[str, Any]]:
        """解析 DuckDuckGo HTML 结果"""
        from html.parser import HTMLParser
        
        results = []
        
        class DDGParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.in_result = False
                self.in_title = False
                self.in_snippet = False
                self.current = {}
                self.results = []
            
            def handle_starttag(self, tag, attrs):
                attrs_dict = dict(attrs)
                cls = attrs_dict.get("class", "")
                
                if tag == "div" and "result" in cls:
                    self.in_result = True
                    self.current = {}
                elif self.in_result and tag == "a" and "result__a" in cls:
                    self.in_title = True
                    self.current["url"] = attrs_dict.get("href", "")
                elif self.in_result and tag == "a" and "result__snippet" in cls:
                    self.in_snippet = True
            
            def handle_endtag(self, tag):
                if tag == "a":
                    if self.in_title:
                        self.in_title = False
                    elif self.in_snippet:
                        self.in_snippet = False
                elif tag == "div" and self.in_result:
                    if self.current.get("title"):
                        self.results.append(self.current)
                    self.in_result = False
            
            def handle_data(self, data):
                text = data.strip()
                if not text:
                    return
                if self.in_title:
                    self.current["title"] = self.current.get("title", "") + text
                elif self.in_snippet:
                    self.current["snippet"] = self.current.get("snippet", "") + text
        
        parser = DDGParser()
        parser.feed(html)
        
        for r in parser.results[:num_results]:
            # 清理 URL（DuckDuckGo 会加跳转前缀）
            raw_url = r.get("url", "")
            if "uddg=" in raw_url:
                from urllib.parse import unquote, parse_qs, urlparse
                parsed = urlparse(raw_url)
                qs = parse_qs(parsed.query)
                r["url"] = unquote(qs.get("uddg", [raw_url])[0])
            
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("snippet", ""),
            })
        
        return results


@register_tool
class WebSearchTool(BaseTool):
    """
    web_search - 联网搜索
    
    当用户的问题需要最新信息、实时数据、或文档中没有的内容时，
    使用此工具搜索互联网获取答案。
    """
    
    name = "web_search"
    description = """在互联网上搜索信息。当用户的问题涉及：
- 最新新闻、时事、天气、股价等实时信息
- 文档中没有的外部知识
- 需要验证或补充的信息
- 技术文档、API 参考、代码示例

使用此工具联网搜索获取最新结果。"""
    
    parameters = [
        ToolParameter(
            name="query",
            type="string",
            description="搜索关键词",
            required=True,
        ),
        ToolParameter(
            name="num_results",
            type="number",
            description="返回结果数量，默认 5，最大 10",
            default=5,
        ),
    ]
    
    def __init__(self):
        super().__init__()
        self.engine = DuckDuckGoSearchEngine()
    
    async def execute(self, query: str, num_results: int = 5) -> ToolResult:
        if not query.strip():
            return ToolResult(success=False, error="搜索关键词不能为空")
        
        num_results = min(max(1, num_results), 10)
        
        logger.info(f"[Web Search] 搜索: {query} (最多{num_results}条)")
        
        try:
            results = await self.engine.search(query, num_results)
            
            if not results:
                return ToolResult(success=True, data={
                    "found": False,
                    "query": query,
                    "message": f"未找到与 '{query}' 相关的搜索结果",
                    "results": [],
                })
            
            return ToolResult(success=True, data={
                "found": True,
                "query": query,
                "count": len(results),
                "results": results,
            })
            
        except Exception as e:
            logger.error(f"Web 搜索异常: {e}", exc_info=True)
            return ToolResult(success=False, error=f"搜索执行异常: {str(e)}")


@register_tool
class WebFetchTool(BaseTool):
    """
    web_fetch - 获取指定网页内容
    
    当搜索结果中找到了相关网页，但需要更详细的内容时使用此工具。
    """
    
    name = "web_fetch"
    description = """获取指定 URL 的网页正文内容。
当需要读取某个网页的详细内容、文章全文时使用此工具。
注意：只用于获取公开可访问的网页内容。"""
    
    parameters = [
        ToolParameter(
            name="url",
            type="string",
            description="要获取内容的网页 URL",
            required=True,
        ),
        ToolParameter(
            name="max_length",
            type="number",
            description="返回的最大字符数，默认 5000",
            default=5000,
        ),
    ]
    
    async def execute(self, url: str, max_length: int = 5000) -> ToolResult:
        if not url.strip():
            return ToolResult(success=False, error="URL 不能为空")
        
        # 简单校验 URL 格式
        if not url.startswith(("http://", "https://")):
            return ToolResult(success=False, error="URL 必须以 http:// 或 https:// 开头")
        
        logger.info(f"[Web Fetch] 获取: {url}")
        
        try:
            import urllib.request
            
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
            )
            
            with urllib.request.urlopen(req, timeout=20) as resp:
                content_type = resp.headers.get("Content-Type", "")
                raw = resp.read(max_length + 1000).decode("utf-8", errors="ignore")
            
            # 简单提取正文（去除 HTML 标签）
            text = self._strip_html(raw)
            
            if len(text) > max_length:
                text = text[:max_length] + "\n...（内容已截断）"
            
            return ToolResult(success=True, data={
                "url": url,
                "content_type": content_type,
                "content": text,
                "char_count": len(text),
            })
            
        except Exception as e:
            logger.error(f"Web Fetch 异常: {e}")
            return ToolResult(success=False, error=f"获取网页失败: {str(e)}")
    
    def _strip_html(self, html: str) -> str:
        """简单 HTML 标签清除 + 基本格式保留"""
        from html.parser import HTMLParser
        
        class TextExtractor(HTMLParser):
            def __init__(self):
                super().__init__()
                self.result = []
                self.skip_tags = {"script", "style", "head", "meta", "link"}
                self.in_skip = False
            
            def handle_starttag(self, tag, attrs):
                if tag in self.skip_tags:
                    self.in_skip = True
                elif tag in ("p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr"):
                    self.result.append("\n")
            
            def handle_endtag(self, tag):
                if tag in self.skip_tags:
                    self.in_skip = False
                elif tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li"):
                    self.result.append("\n")
            
            def handle_data(self, data):
                if not self.in_skip:
                    self.result.append(data)
            
            def get_text(self):
                text = "".join(self.result)
                # 清理多余空白
                lines = [line.strip() for line in text.split("\n")]
                lines = [line for line in lines if line]
                return "\n".join(lines)
        
        extractor = TextExtractor()
        extractor.feed(html)
        return extractor.get_text()
