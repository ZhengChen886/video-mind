import os
import asyncio
import threading
import re
from pathlib import Path

# 支持的音色列表
SUPPORTED_VOICES = [
    {"name": "晓晓 (女)", "code": "zh-CN-XiaoxiaoNeural"},
    {"name": "云希 (女)", "code": "zh-CN-YunxiNeural"},
    {"name": "晓辰 (男)", "code": "zh-CN-XiaochenNeural"},
    {"name": "晓宇 (男)", "code": "zh-CN-XiaoyuNeural"},
    {"name": "云扬 (男)", "code": "zh-CN-YunyangNeural"},
    {"name": "艾琳 (女, 英文)", "code": "en-US-AriaNeural"},
    {"name": "大卫 (男, 英文)", "code": "en-US-DavidNeural"},
]


def clean_markdown_text(text: str) -> str:
    """
    清理 Markdown 文本，剔除与原文无关的符号
    
    Args:
        text: 原始 Markdown 文本
    
    Returns:
        str: 清理后的纯文本
    """
    if not text:
        return text
    
    # 1. 移除代码块 (```code```)
    cleaned = re.sub(r'```[\s\S]*?```', '', text)
    
    # 2. 移除行内代码 (`code`)
    cleaned = re.sub(r'`[^`]+`', '', cleaned)
    
    # 3. 移除标题符号 (# ## ###)
    cleaned = re.sub(r'^#{1,6}\s+', '', cleaned, flags=re.MULTILINE)
    
    # 4. 移除粗体和斜体 (**text** *text*)
    cleaned = re.sub(r'\*\*(.*?)\*\*', r'\1', cleaned)
    cleaned = re.sub(r'\*(.*?)\*', r'\1', cleaned)
    
    # 5. 移除删除线 (~~text~~)
    cleaned = re.sub(r'~~(.*?)~~', r'\1', cleaned)
    
    # 6. 移除链接和图片 ([text](url) ![alt](url))
    cleaned = re.sub(r'!\[.*?\]\(.*?\)', '', cleaned)
    cleaned = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', cleaned)
    
    # 7. 移除引用符号 (>)
    cleaned = re.sub(r'^\s*>\s+', '', cleaned, flags=re.MULTILINE)
    
    # 8. 移除列表符号 (- + *)
    cleaned = re.sub(r'^\s*[-+*]\s+', '', cleaned, flags=re.MULTILINE)
    
    # 9. 移除数字列表符号 (1. 2.)
    # cleaned = re.sub(r'^\s*\d+\.\s+', '', cleaned, flags=re.MULTILINE)
    
    # 10. 移除表格
    cleaned = re.sub(r'^\|.*\|$', '', cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r'^\s*[-:|]+\s*$', '', cleaned, flags=re.MULTILINE)
    
    # 11. 移除分隔线 (--- ___ ***)
    cleaned = re.sub(r'^\s*[-*_]{3,}\s*$', '', cleaned, flags=re.MULTILINE)
    
    # 12. 移除多余的空行
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    
    # 13. 移除行首行尾的空白字符
    cleaned = '\n'.join(line.strip() for line in cleaned.split('\n'))
    
    return cleaned.strip()


def get_supported_voices():
    """
    获取支持的音色列表
    
    Returns:
        list: 音色列表，包含 name 和 code
    """
    return SUPPORTED_VOICES


def text_to_audio_sync(text: str, output_path: str, voice: str = "zh-CN-XiaoxiaoNeural") -> bool:
    """
    将文本转换为音频文件（同步版本，在新线程中执行）
    使用 Edge-TTS（微软云服务）
    
    Args:
        text: 要转换的文本
        output_path: 输出音频文件路径
        voice: 音色代码，默认为晓晓
    
    Returns:
        bool: 转换是否成功
    """
    result = {"success": False}
    
    def _run_in_thread():
        try:
            import edge_tts
            
            print(f"[TTS] 使用 Edge-TTS 进行合成，音色: {voice}")
            
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            async def _synthesize():
                communicate = edge_tts.Communicate(text, voice=voice)
                await communicate.save(output_path)
            
            loop.run_until_complete(_synthesize())
            loop.close()
            result["success"] = True
            
        except ImportError:
            print("[TTS Error] edge-tts 未安装，请运行: pip install edge-tts")
            result["success"] = False
        except Exception as e:
            print(f"[TTS Error] 文本转语音失败: {e}")
            result["success"] = False
    
    # 在新线程中执行，避免与 FastAPI 的事件循环冲突
    thread = threading.Thread(target=_run_in_thread)
    thread.start()
    thread.join()
    
    return result["success"]


def process_text_file(file_path: str, output_audio_path: str = None, voice: str = "zh-CN-XiaoxiaoNeural") -> dict:
    """
    处理文本文件并转换为音频（同步版本）
    
    Args:
        file_path: 输入文本文件路径 (.txt 或 .md)
        output_audio_path: 输出音频文件路径（可选，自动生成）
        voice: 音色代码
    
    Returns:
        dict: 包含转换结果的字典
    """
    try:
        # 读取文本文件
        with open(file_path, 'r', encoding='utf-8') as f:
            text = f.read()
        
        if not text.strip():
            return {
                "success": False,
                "error": "文本文件为空"
            }
        
        # 清理 Markdown 格式符号
        cleaned_text = clean_markdown_text(text)
        print(f"[TTS] 已清理文本，原长度: {len(text)}, 清理后: {len(cleaned_text)}")
        
        if not cleaned_text.strip():
            return {
                "success": False,
                "error": "清理后的文本为空"
            }
        
        # 生成输出路径（如果未提供）
        if output_audio_path is None:
            base_name = os.path.splitext(file_path)[0]
            output_audio_path = f"{base_name}.mp3"
        
        # 转换文本为音频（在新线程中执行）
        print(f"[TTS] 正在转换: {file_path} -> {output_audio_path}")
        success = text_to_audio_sync(cleaned_text, output_audio_path, voice)
        
        if success:
            print(f"[TTS] 已输出至: {output_audio_path}")
            return {
                "success": True,
                "text": cleaned_text,
                "original_text": text,
                "audio_path": output_audio_path,
                "file_name": os.path.basename(output_audio_path)
            }
        else:
            return {
                "success": False,
                "error": "音频合成失败"
            }
    
    except Exception as e:
        print(f"[TTS Error] 处理文件失败: {e}")
        return {
            "success": False,
            "error": str(e)
        }


# 测试函数
if __name__ == "__main__":
    test_text_path = r"D:\G.soft\WorkBuddy Work\20260512.md"
    output_path = r"D:\G.soft\WorkBuddy Work\20260512.mp3"
    
    print(f"[TTS Test] 测试文件: {test_text_path}")
    print(f"[TTS Test] 输出路径: {output_path}")
    
    result = process_text_file(test_text_path, output_path, voice="zh-CN-XiaoxiaoNeural")
    
    if result["success"]:
        print("[TTS Test] 测试成功！")
    else:
        print(f"[TTS Test] 测试失败: {result.get('error', '未知错误')}")