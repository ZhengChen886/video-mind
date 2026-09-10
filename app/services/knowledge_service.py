import os
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any, Callable
from app.repositories.knowledge_repo import KnowledgeRepository
from app.models.knowledge import (
    DocumentMetadata, Conversation, Favorite,
    ChatMessage, ChatRequest, ChatResponse
)

logger = logging.getLogger(__name__)

# 批量索引支持的文件扩展名（.doc 为旧二进制格式，仅列出，读取时可能跳过）
SUPPORTED_BATCH_EXTENSIONS = {'.md', '.txt', '.pdf', '.docx', '.doc', '.py', '.js', '.html', '.csv'}

# 单个文件大小上限（10MB），超过则跳过
MAX_FILE_SIZE = 10 * 1024 * 1024


class KnowledgeService:
    def __init__(self, repo: KnowledgeRepository = None):
        self.repo = repo or KnowledgeRepository()
        self._rag_service = None

    def _get_rag_service(self):
        """延迟导入 RAGChatService，避免服务层循环依赖"""
        if self._rag_service is None:
            from app.rag.chat_service import RAGChatService
            self._rag_service = RAGChatService()
        return self._rag_service

    @staticmethod
    def _is_dangerous_path(target: Path) -> bool:
        """复用文件操作层的危险路径检查（系统目录/磁盘根）"""
        from app.file_operations.file_manager import _is_dangerous_path
        return _is_dangerous_path(target)

    @staticmethod
    def _read_file_content(path: Path) -> Optional[str]:
        """
        读取文件内容为纯文本

        - 文本类（md/txt/py/js/html/csv）：UTF-8 读取
        - pdf：尝试 pypdf（可选依赖，未安装返回 None）
        - docx：尝试 python-docx（可选依赖，未安装返回 None）
        - doc（旧二进制格式）：暂不支持，返回 None
        """
        ext = path.suffix.lower()
        try:
            if ext in ('.md', '.txt', '.py', '.js', '.html', '.csv'):
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    return f.read()
            if ext == '.pdf':
                try:
                    from pypdf import PdfReader
                except ImportError:
                    logger.warning(f"跳过 {path.name}：未安装 pypdf（pip install pypdf）")
                    return None
                reader = PdfReader(str(path))
                return "\n\n".join(page.extract_text() or "" for page in reader.pages)
            if ext == '.docx':
                try:
                    import docx
                except ImportError:
                    logger.warning(f"跳过 {path.name}：未安装 python-docx（pip install python-docx）")
                    return None
                doc = docx.Document(str(path))
                return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())
            if ext == '.doc':
                logger.warning(f"跳过 {path.name}：.doc 旧格式暂不支持，请转换为 .docx")
                return None
        except Exception as e:
            logger.warning(f"读取文件失败 {path}: {e}")
            return None
        return None

    def scan_folder(self, folder_path: str) -> Dict[str, Any]:
        """
        递归扫描文件夹，返回所有支持的文件

        安全：拒绝系统目录与磁盘根；单文件超过 10MB 跳过
        """
        folder = Path(folder_path).expanduser()
        if not folder.exists() or not folder.is_dir():
            return {"success": False, "error": f"文件夹不存在或不是目录: {folder_path}"}

        if self._is_dangerous_path(folder):
            return {"success": False, "error": "禁止扫描系统目录或磁盘根目录"}

        files = []
        skipped = []

        for item in folder.rglob('*'):
            try:
                if not item.is_file():
                    continue
                if item.suffix.lower() not in SUPPORTED_BATCH_EXTENSIONS:
                    continue

                size = item.stat().st_size
                if size > MAX_FILE_SIZE:
                    skipped.append({"path": str(item), "reason": f"文件超过 10MB（{size // 1024 // 1024}MB）"})
                    continue

                files.append({
                    "path": str(item),
                    "name": item.name,
                    "type": item.suffix[1:].lower(),
                    "size": size,
                })
            except Exception as e:
                skipped.append({"path": str(item), "reason": str(e)})

        return {
            "success": True,
            "folder": str(folder),
            "total_found": len(files),
            "files": files,
            "skipped": skipped,
        }

    def batch_index(
        self,
        items: List[Dict[str, str]],
        force: bool = False,
        progress_callback: Optional[Callable[[int, int, str], None]] = None
    ) -> Dict[str, Any]:
        """
        批量索引文件或文件夹（支持混合）

        Args:
            items: [{"path": <绝对路径>, "type": "file"|"folder"}, ...]
            force: 强制重新索引（默认跳过已索引文件）
            progress_callback: 进度回调 (当前序号, 总数, 文件名)
        """
        rag = self._get_rag_service()

        # 展开文件夹为文件列表
        to_index: List[Dict[str, Any]] = []
        scan_errors = []

        for item in items:
            path = item.get("path", "")
            item_type = item.get("type", "file")
            p = Path(path).expanduser()

            if not p.exists():
                scan_errors.append({"path": path, "error": "路径不存在"})
                continue

            if p.is_dir() or item_type == "folder":
                if self._is_dangerous_path(p):
                    scan_errors.append({"path": path, "error": "禁止扫描系统目录或磁盘根目录"})
                    continue
                for f in sorted(p.rglob('*')):
                    if f.is_file() and f.suffix.lower() in SUPPORTED_BATCH_EXTENSIONS:
                        size = f.stat().st_size
                        if size <= MAX_FILE_SIZE:
                            to_index.append({"path": str(f), "size": size})
            elif p.is_file():
                if p.suffix.lower() not in SUPPORTED_BATCH_EXTENSIONS:
                    scan_errors.append({"path": path, "error": f"不支持的文件类型: {p.suffix}"})
                    continue
                size = p.stat().st_size
                if size > MAX_FILE_SIZE:
                    scan_errors.append({"path": path, "error": "文件超过 10MB"})
                    continue
                to_index.append({"path": str(p), "size": size})

        total = len(to_index)
        indexed = []
        failed = []
        skipped = []

        for i, file_info in enumerate(to_index, 1):
            file_path = file_info["path"]
            file_name = Path(file_path).name

            if progress_callback:
                try:
                    progress_callback(i, total, file_name)
                except Exception:
                    pass

            # 增量索引：已索引且未强制重索引时跳过
            if not force and rag.check_index_status(file_path).get("is_indexed"):
                skipped.append({"path": file_path, "chunks": rag.vector_store.get_indexed_chunks_count(file_path)})
                continue

            content = self._read_file_content(Path(file_path))
            if not content or not content.strip():
                failed.append({"path": file_path, "error": "内容为空或无法读取"})
                continue

            doc_type = Path(file_path).suffix[1:].lower()
            result = rag.index_document(file_path, content, doc_type)

            if result.get("success"):
                indexed.append({
                    "path": file_path,
                    "name": file_name,
                    "chunks": result.get("indexed_chunks", 0),
                })
            else:
                failed.append({"path": file_path, "error": result.get("error", "索引失败")})

        return {
            "success": True,
            "total": total,
            "indexed_count": len(indexed),
            "skipped_count": len(skipped),
            "failed_count": len(failed),
            "indexed": indexed,
            "skipped": skipped,
            "failed": failed,
            "scan_errors": scan_errors,
        }


    def list_documents(self) -> List[Dict[str, Any]]:
        return self.repo.list_files()

    def get_document(self, file_path: str) -> Optional[Dict[str, Any]]:
        content = self.repo.get_file_content(file_path)
        if content is None:
            return None

        if not file_path.startswith(str(self.repo.base_dir)):
            path_obj = self.repo.base_dir / file_path
        else:
            path_obj = Path(file_path)
            
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
