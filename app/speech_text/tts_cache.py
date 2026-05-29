import os
import json
import hashlib
import time
import shutil
from pathlib import Path
from typing import Dict, List, Optional
import platform
from config.paths import TTS_CACHE_DIR, TTS_AUDIO_DIR, TTS_TEMP_DIR


# 配置参数
CHUNK_SIZE = 1750  # 每段最大字数
MAX_CACHE_FILES = 100  # 最大缓存文件数
MAX_CACHE_DAYS = 3  # 缓存保留天数


# 从配置文件导入路径
CACHE_DIR = TTS_CACHE_DIR
AUDIO_DIR = TTS_AUDIO_DIR
TEMP_DIR = TTS_TEMP_DIR
METADATA_FILE = CACHE_DIR / "cache_metadata.json"


def ensure_dirs():
    """确保必要的目录存在"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)


def _get_file_lock(file_path: Path):
    """获取文件锁（跨平台）"""
    if platform.system() == "Windows":
        import msvcrt
        lock_file = str(file_path) + ".lock"
        lock_fd = open(lock_file, 'w')
        try:
            msvcrt.locking(lock_fd.fileno(), msvcrt.LK_LOCK, 1)
            return lock_fd
        except:
            lock_fd.close()
            raise
    else:
        import fcntl
        lock_file = str(file_path) + ".lock"
        lock_fd = open(lock_file, 'w')
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            return lock_fd
        except:
            lock_fd.close()
            raise


def _release_file_lock(lock_fd):
    """释放文件锁"""
    try:
        lock_fd.close()
        # 尝试删除锁文件
        try:
            os.remove(lock_fd.name)
        except:
            pass
    except:
        pass


def compute_text_hash(text: str) -> str:
    """计算文本的 SHA-256 哈希值"""
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def load_metadata() -> List[Dict]:
    """加载缓存元数据"""
    ensure_dirs()
    if not METADATA_FILE.exists():
        return []
    try:
        with open(METADATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return []


def save_metadata(metadata: List[Dict]):
    """保存缓存元数据（原子写入）"""
    ensure_dirs()
    # 先写入临时文件
    temp_file = METADATA_FILE.with_suffix('.tmp')
    with open(temp_file, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    # 原子替换
    if METADATA_FILE.exists():
        METADATA_FILE.unlink()
    temp_file.rename(METADATA_FILE)


def find_cached_audio(text_hash: str, voice: str) -> Optional[Dict]:
    """查找已缓存的音频"""
    metadata = load_metadata()
    for item in metadata:
        if item.get("hash") == text_hash and item.get("voice") == voice:
            # 检查文件是否存在
            audio_path = AUDIO_DIR / item.get("audio_file", "")
            if audio_path.exists():
                return item
    return None


def add_to_cache(
    text_hash: str,
    voice: str,
    audio_file: str,
    file_size: int,
    source_type: Optional[str] = None,
    source_id: Optional[str] = None,
    source_info: Optional[Dict] = None
) -> Dict:
    """
    添加新的缓存项
    
    Args:
        text_hash: 文本哈希值
        voice: 音色
        audio_file: 音频文件名
        file_size: 文件大小
        source_type: 来源类型 (doc/message)
        source_id: 来源ID
        source_info: 来源详细信息
    
    Returns:
        缓存项
    """
    ensure_dirs()
    
    cache_item = {
        "hash": text_hash,
        "voice": voice,
        "audio_file": audio_file,
        "created_at": time.time(),
        "size": file_size
    }
    
    # 添加来源信息
    if source_type:
        cache_item["source_type"] = source_type
    if source_id:
        cache_item["source_id"] = source_id
    if source_info:
        cache_item["source_info"] = source_info
    
    # 加锁保护元数据操作
    lock_fd = None
    try:
        lock_fd = _get_file_lock(METADATA_FILE)
        metadata = load_metadata()
        
        # 移除相同哈希和音色的旧缓存
        metadata = [
            item for item in metadata
            if not (item.get("hash") == text_hash and item.get("voice") == voice)
        ]
        
        metadata.append(cache_item)
        save_metadata(metadata)
        
        # 触发清理
        _cleanup_cache(metadata)
        
        return cache_item
    finally:
        if lock_fd:
            _release_file_lock(lock_fd)


def _cleanup_cache(metadata: List[Dict]):
    """清理过期缓存"""
    current_time = time.time()
    cutoff_time = current_time - (MAX_CACHE_DAYS * 24 * 60 * 60)
    
    # 筛选未过期的缓存
    valid_items = []
    items_to_delete = []
    
    for item in metadata:
        created_at = item.get("created_at", 0)
        audio_file = item.get("audio_file", "")
        audio_path = AUDIO_DIR / audio_file
        
        if created_at < cutoff_time:
            items_to_delete.append(item)
        elif not audio_path.exists():
            items_to_delete.append(item)
        else:
            valid_items.append(item)
    
    # 如果仍然超过最大数量，删除最旧的
    if len(valid_items) > MAX_CACHE_FILES:
        # 按创建时间排序
        valid_items.sort(key=lambda x: x.get("created_at", 0))
        num_to_delete = len(valid_items) - MAX_CACHE_FILES
        items_to_delete.extend(valid_items[:num_to_delete])
        valid_items = valid_items[num_to_delete:]
    
    # 删除文件
    for item in items_to_delete:
        audio_file = item.get("audio_file", "")
        audio_path = AUDIO_DIR / audio_file
        if audio_path.exists():
            try:
                audio_path.unlink()
            except:
                pass
    
    # 保存更新后的元数据
    if len(valid_items) != len(metadata):
        save_metadata(valid_items)


def delete_cache(text_hash: str, voice: str) -> bool:
    """删除指定缓存"""
    lock_fd = None
    try:
        lock_fd = _get_file_lock(METADATA_FILE)
        metadata = load_metadata()
        
        # 找到并删除
        deleted = False
        new_metadata = []
        for item in metadata:
            if item.get("hash") == text_hash and item.get("voice") == voice:
                audio_file = item.get("audio_file", "")
                audio_path = AUDIO_DIR / audio_file
                if audio_path.exists():
                    try:
                        audio_path.unlink()
                    except:
                        pass
                deleted = True
            else:
                new_metadata.append(item)
        
        if deleted:
            save_metadata(new_metadata)
        
        return deleted
    finally:
        if lock_fd:
            _release_file_lock(lock_fd)


def cleanup_temp_cache(temp_dir: Optional[Path] = None):
    """
    清理临时缓存文件
    
    Args:
        temp_dir: 临时目录，如果为 None 则使用默认的 TEMP_DIR
    """
    temp_dir = temp_dir or TEMP_DIR
    if temp_dir.exists():
        try:
            shutil.rmtree(temp_dir)
            temp_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            print(f"[TTS Cache] 清理临时缓存失败: {e}")


def get_cache_list() -> List[Dict]:
    """获取缓存列表"""
    return load_metadata()


def get_audio_path(audio_file: str) -> Path:
    """获取音频文件完整路径"""
    return AUDIO_DIR / audio_file


def get_temp_dir() -> Path:
    """获取临时文件目录"""
    return TEMP_DIR
