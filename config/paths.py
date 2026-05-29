"""
项目路径管理模块
集中管理项目中的所有路径配置
"""
from pathlib import Path

# 项目根目录（相对于此文件的位置：config/paths.py -> 向上一级）
PROJECT_ROOT = Path(__file__).parent.parent.absolute()

# 核心目录
DATA_DIR = PROJECT_ROOT / "data"
CONFIG_DIR = PROJECT_ROOT / "config"
APP_DIR = PROJECT_ROOT / "app"
WEB_DIR = PROJECT_ROOT / "web"

# 数据目录
VIDEO_DIR = DATA_DIR / "mp4"  # 视频存储目录
KNOWLEDGE_DIR = DATA_DIR / "mp4"  # 知识库文档目录（使用 mp4）
KNOWLEDGE_DATA_DIR = DATA_DIR / "knowledge"  # 知识库数据目录（对话、收藏）
TTS_CACHE_DIR = DATA_DIR / "tts_cache"  # TTS缓存目录
TTS_AUDIO_DIR = TTS_CACHE_DIR / "audio"  # TTS音频目录
TTS_TEMP_DIR = TTS_CACHE_DIR / "temp"  # TTS临时文件目录
VECTOR_DB_DIR = PROJECT_ROOT / "vector_db"  # 向量数据库目录

# 确保目录存在
def ensure_dirs_exist():
    """确保所有必要的目录存在"""
    dirs = [
        DATA_DIR,
        VIDEO_DIR,
        KNOWLEDGE_DIR,
        TTS_CACHE_DIR,
        TTS_AUDIO_DIR,
        TTS_TEMP_DIR,
        VECTOR_DB_DIR,
        CONFIG_DIR,
    ]
    for dir_path in dirs:
        dir_path.mkdir(parents=True, exist_ok=True)
