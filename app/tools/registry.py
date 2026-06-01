"""
工具注册表 - 管理所有可用工具的注册、查找和导出
"""

from typing import Dict, List, Optional, Type, Any
from app.tools.base_tool import BaseTool


class ToolRegistry:
    """全局工具注册表（单例）"""
    
    _instance: Optional["ToolRegistry"] = None
    _tools: Dict[str, BaseTool] = {}
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def register(self, tool: BaseTool) -> None:
        """注册一个工具"""
        self._tools[tool.name] = tool
    
    def get(self, name: str) -> Optional[BaseTool]:
        """按名称获取工具"""
        return self._tools.get(name)
    
    def get_all(self) -> List[BaseTool]:
        """获取所有已注册工具"""
        return list(self._tools.values())
    
    def to_openai_tools(self) -> List[Dict[str, Any]]:
        """导出为 OpenAI tools 格式（用于 API 调用）"""
        return [tool.to_openai_function() for tool in self._tools.values()]
    
    def list_tool_names(self) -> List[str]:
        """列出所有工具名称"""
        return list(self._tools.keys())
    
    def clear(self) -> None:
        """清空所有工具（测试用）"""
        self._tools.clear()


# 全局单例
registry = ToolRegistry()


def register_tool(tool_class: Type[BaseTool]) -> BaseTool:
    """
    装饰器：注册工具类实例到全局注册表
    
    用法：
        @register_tool
        class MyTool(BaseTool):
            name = "my_tool"
            ...
    """
    instance = tool_class()
    registry.register(instance)
    return instance
