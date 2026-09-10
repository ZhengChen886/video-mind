from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime


class DocumentMetadata(BaseModel):
    id: str
    name: str
    path: str
    size: int
    type: str
    created_at: str
    modified_at: str
    indexed: bool = False


class ChatMessage(BaseModel):
    role: str = Field(..., description="user or assistant")
    content: str


class Conversation(BaseModel):
    id: str
    title: str
    doc_id: Optional[str] = None
    doc_name: Optional[str] = None
    messages: List[ChatMessage] = []
    created_at: str
    updated_at: str


class Favorite(BaseModel):
    id: str
    content: str
    question: str = ""
    document: str = ""
    created_at: str


class ChatRequest(BaseModel):
    doc_id: str
    question: str
    history: List[Dict[str, str]] = []
    model: Optional[str] = None
    conv_id: Optional[str] = None
    enable_tools: Optional[bool] = True  # 是否启用 Tool Calling


class ChatResponse(BaseModel):
    success: bool
    answer: Optional[str] = None
    sources: Optional[List[Dict[str, Any]]] = None
    error: Optional[str] = None


class IndexRequest(BaseModel):
    doc_id: str
    doc_path: str


class IndexResponse(BaseModel):
    success: bool
    indexed_chunks: int = 0
    error: Optional[str] = None


# ========== RAG 多文件/文件夹知识库改造：新增请求模型 ==========

class MultiChatRequest(BaseModel):
    """多文档问答请求"""
    doc_ids: List[str]
    question: str
    history: List[Dict[str, str]] = []
    model: Optional[str] = None
    conv_id: Optional[str] = None
    use_reranker: bool = True  # 是否启用 Reranker 二次排序


class CollectionChatRequest(BaseModel):
    """按集合（全库）问答请求"""
    question: str
    history: List[Dict[str, str]] = []
    model: Optional[str] = None
    conv_id: Optional[str] = None
    use_reranker: bool = True


class IndexItem(BaseModel):
    """批量索引的单个条目（文件或文件夹）"""
    path: str
    type: str = "file"  # "file" | "folder"


class BatchIndexRequest(BaseModel):
    """批量索引请求（支持文件和文件夹混合）"""
    items: List[IndexItem]
    force: bool = False  # 强制重新索引（默认跳过已索引文件）


class FileSaveRequest(BaseModel):
    path: str
    content: str


class FavoriteRequest(BaseModel):
    content: str
    question: str = ""
    document: str = ""


class RenameConversationRequest(BaseModel):
    conv_id: str
    title: str
