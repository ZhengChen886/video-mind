"""
知识库工具调用系统 - 基础工具定义

所有工具必须继承 BaseTool 并实现 execute 方法。
工具注册到 ToolRegistry 后，由 ToolOrchestrator 自动转换为 OpenAI function calling 格式。
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field


class ToolParameter(BaseModel):
    """工具参数定义"""
    name: str = Field(..., description="参数名")
    type: str = Field(..., description="参数类型：string, number, boolean, object, array")
    description: str = Field("", description="参数描述")
    required: bool = Field(False, description="是否必填")
    default: Any = Field(None, description="默认值")
    enum: Optional[List[str]] = Field(None, description="可选值列表")


class ToolResult(BaseModel):
    """工具执行结果"""
    success: bool = True
    data: Any = None
    error: str = ""


class BaseTool(ABC):
    """工具基类"""
    
    # 工具元信息（子类必须覆盖）
    name: str = ""
    description: str = ""
    parameters: List[ToolParameter] = []
    
    def __init__(self):
        if not self.name:
            raise ValueError(f"{self.__class__.__name__} 必须定义 name 属性")
    
    def to_openai_function(self) -> Dict[str, Any]:
        """转换为 OpenAI function calling 格式"""
        properties = {}
        required = []
        
        for param in self.parameters:
            prop_def: Dict[str, Any] = {
                "type": param.type,
                "description": param.description
            }
            if param.enum:
                prop_def["enum"] = param.enum
            properties[param.name] = prop_def
            
            if param.required:
                required.append(param.name)
        
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required
                }
            }
        }
    
    @abstractmethod
    async def execute(self, **kwargs) -> ToolResult:
        """执行工具逻辑，子类必须实现"""
        pass
    
    def __repr__(self):
        return f"<Tool {self.name}>"
