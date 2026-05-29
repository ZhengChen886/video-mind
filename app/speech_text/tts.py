import os
import asyncio
import threading
import re
import subprocess
import uuid
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

# 分段参数
CHUNK_SIZE = 1750


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


def split_text_to_chunks(text: str, chunk_size: int = CHUNK_SIZE) -> list:
    """
    将文本按自然断点分段

    Args:
        text: 要分段的文本
        chunk_size: 每段最大字数

    Returns:
        list: 分段后的文本列表
    """
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0
    text_len = len(text)

    # 自然断点优先级：段落结束 > 句子结束 > 逗号 > 空格
    break_points = [
        r'\n\n+',  # 段落结束
        r'[。！？!?]\s*',  # 句子结束
        r'[，,]\s*',  # 逗号
        r'\s+',  # 空格
    ]

    while start < text_len:
        end = min(start + chunk_size, text_len)

        # 如果是最后一段，直接添加
        if end >= text_len:
            chunks.append(text[start:].strip())
            break

        # 寻找最佳断点
        best_break = end
        for pattern in break_points:
            # 在 [start, end] 范围内从后往前找断点
            matches = list(re.finditer(pattern, text[start:end]))
            if matches:
                # 取最后一个匹配的结束位置作为断点
                match = matches[-1]
                best_break = start + match.end()
                break

        # 如果没找到任何断点，强制分段
        if best_break == start:
            best_break = end

        chunks.append(text[start:best_break].strip())
        start = best_break

    return [chunk for chunk in chunks if chunk.strip()]


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

    thread = threading.Thread(target=_run_in_thread)
    thread.start()
    thread.join()

    return result["success"]


def merge_audio_files(audio_files: list, output_path: str) -> bool:
    """
    使用 ffmpeg 合并多个音频文件

    Args:
        audio_files: 音频文件路径列表
        output_path: 输出文件路径

    Returns:
        bool: 合并是否成功
    """
    if not audio_files:
        return False

    try:
        # 创建 ffmpeg concat 所需的文件列表
        list_file = Path(output_path).parent / f"concat_list_{uuid.uuid4().hex}.txt"

        with open(list_file, 'w', encoding='utf-8') as f:
            for audio_file in audio_files:
                f.write(f"file '{Path(audio_file).absolute()}'\n")

        # 使用 ffmpeg concat 协议合并
        cmd = [
            "ffmpeg",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",
            "-y",
            str(output_path)
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=600
        )

        # 清理临时文件
        try:
            list_file.unlink()
        except:
            pass

        if result.returncode == 0:
            return True
        else:
            print(f"[TTS Error] 音频合并失败: {result.stderr}")
            return False

    except Exception as e:
        print(f"[TTS Error] 音频合并异常: {e}")
        return False


def text_to_audio_with_resume(
    text: str,
    output_path: str,
    temp_dir: Path,
    voice: str = "zh-CN-XiaoxiaoNeural",
    chunk_size: int = CHUNK_SIZE
) -> dict:
    """
    支持断点续传的分段文本转语音

    Args:
        text: 要转换的文本
        output_path: 输出音频文件路径
        temp_dir: 临时文件目录
        voice: 音色代码
        chunk_size: 分段大小

    Returns:
        dict: 包含成功状态和输出路径的字典
    """
    try:
        # 分段
        chunks = split_text_to_chunks(text, chunk_size)

        if len(chunks) == 1:
            # 单段直接合成
            success = text_to_audio_sync(text, output_path, voice)
            return {
                "success": success,
                "output_path": output_path if success else None
            }

        # 多段合成
        audio_files = []
        temp_dir.mkdir(parents=True, exist_ok=True)

        for i, chunk in enumerate(chunks):
            chunk_file = temp_dir / f"chunk_{i:04d}.mp3"

            # 检查是否已存在（断点续传）
            if chunk_file.exists() and chunk_file.stat().st_size > 0:
                audio_files.append(str(chunk_file))
                continue

            # 合成当前段
            print(f"[TTS] 正在合成第 {i+1}/{len(chunks)} 段...")
            success = text_to_audio_sync(chunk, str(chunk_file), voice)

            if not success:
                return {
                    "success": False,
                    "error": f"第 {i+1} 段合成失败"
                }

            audio_files.append(str(chunk_file))

        # 合并音频
        print(f"[TTS] 正在合并 {len(audio_files)} 个音频文件...")
        merge_success = merge_audio_files(audio_files, output_path)

        return {
            "success": merge_success,
            "output_path": output_path if merge_success else None
        }

    except Exception as e:
        print(f"[TTS Error] 分段合成失败: {e}")
        return {
            "success": False,
            "error": str(e)
        }


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
