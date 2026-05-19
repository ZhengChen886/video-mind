from typing import List, Optional, Dict, Any
from app.repositories.knowledge_repo import KnowledgeRepository
from app.models.knowledge import (
    DocumentMetadata, Conversation, Favorite,
    ChatMessage, ChatRequest, ChatResponse
)


class KnowledgeService:
    def __init__(self, repo: KnowledgeRepository = None):
        self.repo = repo or KnowledgeRepository()

    def list_documents(self) -> List[Dict[str, Any]]:
        return self.repo.list_files()

    def get_document(self, file_path: str) -> Optional[Dict[str, Any]]:
        content = self.repo.get_file_content(file_path)
        if content is None:
            return None

        path_obj = self.repo.files_dir.parent / file_path if not file_path.startswith(str(self.repo.base_dir)) else None
        if path_obj and path_obj.exists():
            stat = path_obj.stat()
            return {
                "path": str(path_obj),
                "name": path_obj.name,
                "content": content,
                "type": path_obj.suffix[1:],
                "size": stat.st_size,
                "modified_at": str(stat.st_mtime)
            }
        return {"path": file_path, "content": content}

    def save_document(self, file_path: str, content: str) -> bool:
        return self.repo.save_file(file_path, content)

    def upload_document(self, filename: str, content: bytes, target_folder: str = None) -> Optional[Dict[str, Any]]:
        """上传文档，可指定目标文件夹
        Args:
            filename: 文件名
            content: 文件内容
            target_folder: 目标文件夹路径（可选）
        """
        if target_folder:
            # 如果指定了目标文件夹，需要先确保文件夹存在
            import os
            from pathlib import Path
            target_path = Path(target_folder)
            if not target_path.exists():
                return None
            # 修改上传到指定文件夹
            return self.repo.upload_file_to_folder(filename, content, target_folder)
        return self.repo.upload_file(filename, content)

    def delete_document(self, file_path: str) -> bool:
        return self.repo.delete_file(file_path)

    # 文件夹操作
    def create_folder(self, folder_name: str, parent_path: str = None) -> Optional[Dict[str, Any]]:
        return self.repo.create_folder(folder_name, parent_path)

    def rename_folder(self, old_path: str, new_name: str) -> Optional[Dict[str, Any]]:
        return self.repo.rename_folder(old_path, new_name)

    def delete_folder(self, folder_path: str) -> bool:
        return self.repo.delete_folder(folder_path)

    def move_file(self, file_path: str, target_folder_path: str) -> Optional[Dict[str, Any]]:
        return self.repo.move_file(file_path, target_folder_path)

    def list_conversations(self) -> List[Dict[str, Any]]:
        return self.repo.list_conversations()

    def get_conversation(self, conv_id: str) -> Optional[Dict[str, Any]]:
        return self.repo.get_conversation(conv_id)

    def save_conversation(self, conversation: Dict[str, Any]) -> Dict[str, Any]:
        if "messages" not in conversation:
            conversation["messages"] = []

        if not conversation.get("title") and conversation["messages"]:
            user_msg = next((m for m in conversation["messages"] if m.get("role") == "user"), None)
            if user_msg:
                content = user_msg.get("content", "")[:50]
                conversation["title"] = content + ("..." if len(user_msg.get("content", "")) > 50 else "")

        success = self.repo.save_conversation(conversation)
        if success:
            return conversation
        return None

    def delete_conversation(self, conv_id: str) -> bool:
        return self.repo.delete_conversation(conv_id)

    def rename_conversation(self, conv_id: str, new_title: str) -> bool:
        conversation = self.repo.get_conversation(conv_id)
        if not conversation:
            return False
        conversation["title"] = new_title
        return self.repo.save_conversation(conversation)

    def get_favorites(self) -> List[Dict[str, Any]]:
        return self.repo.get_favorites()

    def add_favorite(self, content: str, question: str = "", document: str = "") -> Optional[Dict[str, Any]]:
        return self.repo.add_favorite(content, question, document)

    def delete_favorite(self, fav_id: str) -> bool:
        return self.repo.delete_favorite(fav_id)

    def export_favorites(self) -> Optional[str]:
        return self.repo.export_favorites_to_markdown()

    def create_new_conversation(self, doc_id: str = None, doc_name: str = None) -> Dict[str, Any]:
        from datetime import datetime
        import uuid

        conversation = {
            "id": str(uuid.uuid4()),
            "title": "新对话",
            "doc_id": doc_id,
            "doc_name": doc_name,
            "messages": [],
            "created_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat()
        }
        self.repo.save_conversation(conversation)
        return conversation
