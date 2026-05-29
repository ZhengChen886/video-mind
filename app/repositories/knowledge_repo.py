import os
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Dict, Any
from config.paths import KNOWLEDGE_DIR, KNOWLEDGE_DATA_DIR


class KnowledgeRepository:
    def __init__(self, base_dir: str = None):
        if base_dir is None:
            self.base_dir = KNOWLEDGE_DIR
        else:
            self.base_dir = Path(base_dir)
        self.files_dir = self.base_dir  # 直接使用 mp4 目录
        self.conversations_dir = KNOWLEDGE_DATA_DIR / "conversations"
        self.favorites_file = KNOWLEDGE_DATA_DIR / "favorites.json"

        self._ensure_dirs()

    def _ensure_dirs(self):
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self.conversations_dir.mkdir(parents=True, exist_ok=True)
        if not self.favorites_file.exists():
            self._save_favorites([])

    def _save_favorites(self, favorites: List[Dict]):
        with open(self.favorites_file, 'w', encoding='utf-8') as f:
            json.dump(favorites, f, ensure_ascii=False, indent=2)

    def list_files(self) -> List[Dict[str, Any]]:
        """递归获取文件树结构"""
        def _scan_directory(dir_path: Path) -> List[Dict[str, Any]]:
            items = []
            try:
                for item_path in dir_path.iterdir():
                    if item_path.is_dir():
                        # 文件夹
                        children = _scan_directory(item_path)
                        stat = item_path.stat()
                        items.append({
                            "type": "folder",
                            "name": item_path.name,
                            "path": str(item_path),
                            "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                            "children": children
                        })
                    elif item_path.is_file() and item_path.suffix in ['.md', '.txt']:
                        # 文件
                        stat = item_path.stat()
                        items.append({
                            "type": "file",
                            "id": item_path.stem,
                            "name": item_path.name,
                            "path": str(item_path),
                            "size": stat.st_size,
                            "file_type": item_path.suffix[1:],
                            "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
                        })
            except Exception:
                pass
            
            # 排序：文件夹在前，文件在后；各自按修改时间倒序
            folders = sorted([i for i in items if i['type'] == 'folder'], 
                           key=lambda x: x['modified_at'], reverse=True)
            files = sorted([i for i in items if i['type'] == 'file'],
                          key=lambda x: x['modified_at'], reverse=True)
            return folders + files
        
        return _scan_directory(self.files_dir)
    
    def create_folder(self, folder_name: str, parent_path: str = None) -> Optional[Dict[str, Any]]:
        """创建文件夹"""
        try:
            if parent_path:
                target_dir = Path(parent_path)
            else:
                target_dir = self.files_dir
            
            new_folder = target_dir / folder_name
            new_folder.mkdir(parents=True, exist_ok=True)
            
            stat = new_folder.stat()
            return {
                "type": "folder",
                "name": new_folder.name,
                "path": str(new_folder),
                "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "children": []
            }
        except Exception:
            return None
    
    def rename_folder(self, old_path: str, new_name: str) -> Optional[Dict[str, Any]]:
        """重命名文件夹"""
        try:
            old_folder = Path(old_path)
            if not old_folder.exists() or not old_folder.is_dir():
                return None
            
            new_folder = old_folder.parent / new_name
            old_folder.rename(new_folder)
            
            # 更新所有引用该路径的对话记录
            self._update_conversation_paths(str(old_folder), str(new_folder))
            
            stat = new_folder.stat()
            return {
                "type": "folder",
                "name": new_folder.name,
                "path": str(new_folder),
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
            }
        except Exception:
            return None
    
    def delete_folder(self, folder_path: str) -> bool:
        """删除文件夹（递归删除内容）"""
        try:
            import shutil
            folder = Path(folder_path)
            if not folder.exists() or not folder.is_dir():
                return False
            
            # 先更新相关对话记录（标记为已删除）
            self._mark_conversations_for_deleted_path(str(folder))
            
            shutil.rmtree(folder)
            return True
        except Exception:
            return False
    
    def move_file(self, file_path: str, target_folder_path: str) -> Optional[Dict[str, Any]]:
        """移动文件到目标文件夹"""
        try:
            src_file = Path(file_path)
            target_folder = Path(target_folder_path)
            
            if not src_file.exists() or not src_file.is_file():
                return None
            if not target_folder.exists() or not target_folder.is_dir():
                return None
            
            dst_file = target_folder / src_file.name
            # 如果目标文件已存在，添加后缀
            counter = 1
            while dst_file.exists():
                dst_file = target_folder / f"{src_file.stem}_{counter}{src_file.suffix}"
                counter += 1
            
            src_file.rename(dst_file)
            
            # 更新相关对话记录中的路径
            old_path_str = str(src_file)
            new_path_str = str(dst_file)
            self._update_conversation_paths(old_path_str, new_path_str)
            
            stat = dst_file.stat()
            return {
                "type": "file",
                "id": dst_file.stem,
                "name": dst_file.name,
                "path": new_path_str,
                "size": stat.st_size,
                "file_type": dst_file.suffix[1:],
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
            }
        except Exception:
            return None
    
    def _update_conversation_paths(self, old_path_prefix: str, new_path_prefix: str) -> None:
        """更新对话记录中的文档路径"""
        try:
            for conv_file in self.conversations_dir.glob("*.json"):
                try:
                    with open(conv_file, 'r', encoding='utf-8') as f:
                        conv = json.load(f)
                    
                    updated = False
                    doc_id = conv.get("doc_id", "")
                    if doc_id and doc_id.startswith(old_path_prefix):
                        conv["doc_id"] = doc_id.replace(old_path_prefix, new_path_prefix, 1)
                        updated = True
                    
                    if updated:
                        with open(conv_file, 'w', encoding='utf-8') as f:
                            json.dump(conv, f, ensure_ascii=False, indent=2)
                except Exception:
                    continue
        except Exception:
            pass
    
    def _mark_conversations_for_deleted_path(self, deleted_path_prefix: str) -> None:
        """标记与已删除路径相关的对话（可选处理）"""
        # 目前保留对话记录，只是文档不存在时显示提示
        pass

    def get_file_content(self, file_path: str) -> Optional[str]:
        path = Path(file_path)
        if not path.exists():
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception:
            return None

    def save_file(self, file_path: str, content: str) -> bool:
        try:
            path = Path(file_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)
            return True
        except Exception:
            return False

    def upload_file(self, filename: str, content: bytes) -> Optional[Dict[str, Any]]:
        return self.upload_file_to_folder(filename, content, str(self.files_dir))
    
    def upload_file_to_folder(self, filename: str, content: bytes, target_folder: str) -> Optional[Dict[str, Any]]:
        try:
            target_dir = Path(target_folder)
            file_path = target_dir / filename
            if file_path.exists():
                stem = file_path.stem
                suffix = file_path.suffix
                counter = 1
                while file_path.exists():
                    file_path = target_dir / f"{stem}_{counter}{suffix}"
                    counter += 1

            with open(file_path, 'wb') as f:
                f.write(content)

            stat = file_path.stat()
            return {
                "type": "file",
                "id": file_path.stem,
                "name": file_path.name,
                "path": str(file_path),
                "size": stat.st_size,
                "file_type": file_path.suffix[1:],
                "created_at": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat()
            }
        except Exception:
            return None

    def delete_file(self, file_path: str) -> bool:
        try:
            path = Path(file_path)
            if path.exists():
                path.unlink()
                return True
            return False
        except Exception:
            return False

    def list_conversations(self) -> List[Dict[str, Any]]:
        conversations = []
        for conv_file in self.conversations_dir.glob("*.json"):
            try:
                with open(conv_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    conversations.append({
                        "id": data.get("id"),
                        "title": data.get("title", "未命名对话"),
                        "doc_id": data.get("doc_id"),
                        "doc_name": data.get("doc_name"),
                        "created_at": data.get("created_at"),
                        "updated_at": data.get("updated_at"),
                        "message_count": len(data.get("messages", []))
                    })
            except Exception:
                continue
        return sorted(conversations, key=lambda x: x.get('updated_at', ''), reverse=True)

    def get_conversation(self, conv_id: str) -> Optional[Dict[str, Any]]:
        conv_file = self.conversations_dir / f"{conv_id}.json"
        if not conv_file.exists():
            return None
        try:
            with open(conv_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return None

    def save_conversation(self, conversation: Dict[str, Any]) -> bool:
        try:
            if "id" not in conversation:
                conversation["id"] = str(uuid.uuid4())
            if "created_at" not in conversation:
                conversation["created_at"] = datetime.now().isoformat()
            conversation["updated_at"] = datetime.now().isoformat()
            
            # 去重：去除连续重复的消息
            if "messages" in conversation and conversation["messages"]:
                cleaned_messages = []
                for msg in conversation["messages"]:
                    # 如果和上一条消息不重复（角色和内容都一样），才添加
                    if not cleaned_messages or not (
                        cleaned_messages[-1].get("role") == msg.get("role") and
                        cleaned_messages[-1].get("content") == msg.get("content")
                    ):
                        cleaned_messages.append(msg)
                conversation["messages"] = cleaned_messages

            conv_file = self.conversations_dir / f"{conversation['id']}.json"
            with open(conv_file, 'w', encoding='utf-8') as f:
                json.dump(conversation, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            return False

    def delete_conversation(self, conv_id: str) -> bool:
        try:
            conv_file = self.conversations_dir / f"{conv_id}.json"
            if conv_file.exists():
                conv_file.unlink()
                return True
            return False
        except Exception:
            return False

    def get_favorites(self) -> List[Dict[str, Any]]:
        try:
            with open(self.favorites_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return []

    def add_favorite(self, content: str, question: str = "", document: str = "") -> Optional[Dict[str, Any]]:
        try:
            favorites = self.get_favorites()
            favorite = {
                "id": str(uuid.uuid4()),
                "content": content,
                "question": question,
                "document": document,
                "created_at": datetime.now().isoformat()
            }
            favorites.insert(0, favorite)
            self._save_favorites(favorites)
            return favorite
        except Exception:
            return None

    def delete_favorite(self, fav_id: str) -> bool:
        try:
            favorites = self.get_favorites()
            favorites = [f for f in favorites if f.get("id") != fav_id]
            self._save_favorites(favorites)
            return True
        except Exception:
            return False

    def export_favorites_to_markdown(self, output_path: str = None) -> Optional[str]:
        try:
            favorites = self.get_favorites()
            if not output_path:
                output_path = self.base_dir / f"favorites_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"

            lines = ["# 收藏内容导出\n", f"导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n", "---\n"]

            for i, fav in enumerate(favorites, 1):
                lines.append(f"## {i}. {fav.get('document', '未命名')}\n")
                lines.append(f"**时间**：{fav.get('created_at', '')}\n\n")
                if fav.get('question'):
                    lines.append(f"**问题**：{fav['question']}\n\n")
                lines.append(f"**回答**：\n{fav.get('content', '')}\n\n")
                lines.append("---\n\n")

            with open(output_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)

            return str(output_path)
        except Exception:
            return None
