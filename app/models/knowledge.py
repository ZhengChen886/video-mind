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
