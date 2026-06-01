"""
工具包初始化 - 导入所有工具以触发注册

在应用启动时 import 此模块，所有 @register_tool 装饰的工具会自动注册到全局 registry。
"""

# 导入内置知识库工具
from app.tools.builtin_knowledge_tools import (
    LookupTextTool,
    GetDocInfoTool,
    GetSectionContentTool,
)

# 导入 Web 搜索工具
from app.tools.web_search_tools import (
    WebSearchTool,
    WebFetchTool,
)


def get_all_registered_tool_names():
    """获取所有已注册的工具名称列表"""
    from app.tools.registry import registry
    return registry.list_tool_names()


__all__ = [
    "LookupTextTool",
    "GetDocInfoTool", 
    "GetSectionContentTool",
    "WebSearchTool",
    "WebFetchTool",
    "get_all_registered_tool_names",
]
