import os
import re
import time
from typing import List, Dict, Any, Optional

import config.config_manager

try:
    from openai import OpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

client = config.config_manager.create_openai_client()


def read_md_file(file_path: str) -> str:
    """
    读取 MD 文件内容
    
    Args:
        file_path: MD 文件路径
    
    Returns:
        文件内容字符串
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"[Content Analyzer] 文件未找到: {file_path}")
        return ""
    except Exception as e:
        print(f"[Content Analyzer] 读取文件失败: {e}")
        return ""


def write_md_file(file_path: str, content: str) -> bool:
    """
    写入 MD 文件内容
    
    Args:
        file_path: 输出文件路径
        content: 要写入的内容
    
    Returns:
        是否成功
    """
    try:
        output_dir = os.path.dirname(file_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"[Content Analyzer] 文件写入成功: {file_path}")
        return True
    except Exception as e:
        print(f"[Content Analyzer] 写入文件失败: {e}")
        return False


def generate_summary(text: str, max_length: int = 500) -> str:
    """
    生成文本总结（基于规则的简单实现）
    
    Args:
        text: 原始文本
        max_length: 总结最大长度
    
    Returns:
        总结文本
    """
    if not text.strip():
        return "文本内容为空"
    
    sentences = re.split(r'[。！？\n]', text)
    sentences = [s.strip() for s in sentences if s.strip()]
    
    if len(sentences) <= 3:
        return text[:max_length]
    
    summary_parts = sentences[:2]
    
    keywords = ["重要", "关键", "总结", "结论", "建议", "需要", "必须", "首先", "其次", "最后"]
    for sentence in sentences:
        if any(keyword in sentence for keyword in keywords) or any(char.isdigit() for char in sentence):
            if sentence not in summary_parts:
                summary_parts.append(sentence)
                if len(summary_parts) >= 5:
                    break
    
    if sentences[-1] not in summary_parts:
        summary_parts.append(sentences[-1])
    
    summary = "。".join(summary_parts) + "。"
    
    if len(summary) > max_length:
        summary = summary[:max_length - 3] + "..."
    
    return summary


def generate_notes(text: str) -> List[str]:
    """
    生成笔记（提取关键点）
    
    Args:
        text: 原始文本
    
    Returns:
        笔记列表
    """
    if not text.strip():
        return []
    
    notes = []
    
    paragraphs = re.split(r'\n{2,}', text)
    
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if len(paragraph) < 10:
            continue
        
        lines = paragraph.split('\n')
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            if re.match(r'^\s*(\d+[\.\、])\s+', line):
                notes.append(line)
            elif len(line) > 10 and len(line) < 100:
                notes.append(line)
    
    notes = list(dict.fromkeys(notes))[:20]
    
    return notes


def generate_outline(text: str) -> List[Dict[str, Any]]:
    """
    生成大纲结构
    
    Args:
        text: 原始文本
    
    Returns:
        大纲结构列表
    """
    if not text.strip():
        return []
    
    outline = []
    
    paragraphs = re.split(r'\n{2,}', text)
    
    section_patterns = [
        (r'^(\d+)\、(.+)', 1),
        (r'^(\d+)\.(.+)', 1),
        (r'^第(\d+)章(.+)', 1),
        (r'^第(\d+)节(.+)', 1),
        (r'^【(.+)】', 2),
        (r'^\*(.+)', 2),
        (r'^- (.+)', 2),
    ]
    
    current_section = None
    
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if len(paragraph) < 5:
            continue
        
        matched = False
        for pattern, level in section_patterns:
            match = re.match(pattern, paragraph)
            if match:
                title = match.group(level).strip()
                if len(title) > 3:
                    current_section = {
                        "level": level,
                        "title": title,
                        "content": ""
                    }
                    outline.append(current_section)
                    matched = True
                    break
        
        if not matched and current_section:
            if len(current_section["content"]) == 0:
                current_section["content"] = paragraph[:200]
            else:
                current_section["content"] += " " + paragraph[:100]
    
    outline = [item for item in outline if item["content"].strip()]
    
    return outline


def generate_summary_ai(text: str, api_url: str = None, api_key: str = None, model: str = None) -> str:
    """
    AI 生成文本总结
    
    Args:
        text: 原始文本
        api_url: API地址（可选，默认使用全局配置）
        api_key: API密钥（可选，默认使用全局配置）
        model: 模型名称（可选，默认使用全局配置）
    
    Returns:
        总结文本
    """
    if not OPENAI_AVAILABLE:
        print("[Content Analyzer] OpenAI 不可用，使用规则引擎生成总结")
        return generate_summary(text)
    
    try:
        # 创建临时客户端
        temp_client = None
        config = config.config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai") if config else "open-ai"
        provider_config = config.get("providers", {}).get(active_provider, {}) if config else {}
        use_model = model or provider_config.get("default_model", "")
        
        if api_url and api_key:
            temp_client = OpenAI(
                base_url=api_url,
                api_key=api_key,
            )
        elif client is not None:
            temp_client = client
        
        if temp_client is None:
            print("[Content Analyzer] 无可用API客户端，使用规则引擎生成总结")
            return generate_summary(text)
        
        prompt = f"""请对以下视频字幕文本进行专业总结，提取核心内容和关键信息：

{text[:4000]}

请用中文输出详细的总结报告，保持在 300-500 字。
"""
        
        print(f"[Content Analyzer] 使用模型: {use_model}")
        
        completion = temp_client.chat.completions.create(
            model=use_model,
            messages=[
                {"role": "user", "content": prompt}
            ],
            timeout=60
        )
        
        result = completion.choices[0].message.content.strip()
        print("[Content Analyzer] AI 总结生成成功")
        return result
    except Exception as e:
        print(f"[Content Analyzer] AI 总结生成失败: {e}，降级使用规则引擎")
        return generate_summary(text)


def generate_notes_ai(text: str, api_url: str = None, api_key: str = None, model: str = None) -> List[str]:
    """
    AI 生成笔记
    
    Args:
        text: 原始文本
        api_url: API地址（可选，默认使用全局配置）
        api_key: API密钥（可选，默认使用全局配置）
        model: 模型名称（可选，默认使用全局配置）
    
    Returns:
        笔记列表
    """
    if not OPENAI_AVAILABLE:
        print("[Content Analyzer] OpenAI 不可用，使用规则引擎生成笔记")
        return generate_notes(text)
    
    try:
        # 创建临时客户端
        temp_client = None
        config = config.config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai") if config else "open-ai"
        provider_config = config.get("providers", {}).get(active_provider, {}) if config else {}
        use_model = model or provider_config.get("default_model", "")
        
        if api_url and api_key:
            temp_client = OpenAI(
                base_url=api_url,
                api_key=api_key,
            )
        elif client is not None:
            temp_client = client
        
        if temp_client is None:
            print("[Content Analyzer] 无可用API客户端，使用规则引擎生成笔记")
            return generate_notes(text)
        
        prompt = f"""请从以下视频字幕文本中提取关键要点，生成笔记列表：

{text[:4000]}

要求：
1. 每条笔记不超过 50 字
2. 只提取最重要的信息
3. 输出格式：每行一条，以数字开头，如：
1. xxx
2. xxx
"""
        
        print(f"[Content Analyzer] 使用模型: {use_model}")
        
        completion = temp_client.chat.completions.create(
            model=use_model,
            messages=[
                {"role": "user", "content": prompt}
            ],
            timeout=60
        )
        
        result = completion.choices[0].message.content.strip()
        
        notes = []
        for line in result.split('\n'):
            line = line.strip()
            match = re.match(r'^\d+\.\s*(.+)', line)
            if match:
                notes.append(match.group(1).strip())
            elif line and not line.startswith('---'):
                notes.append(line)
        
        notes = [n for n in notes if n]
        print("[Content Analyzer] AI 笔记生成成功")
        return notes[:20]
    except Exception as e:
        print(f"[Content Analyzer] AI 笔记生成失败: {e}，降级使用规则引擎")
        return generate_notes(text)


def generate_outline_ai(text: str, api_url: str = None, api_key: str = None, model: str = None) -> List[Dict[str, Any]]:
    """
    AI 生成大纲结构
    
    Args:
        text: 原始文本
        api_url: API地址（可选，默认使用全局配置）
        api_key: API密钥（可选，默认使用全局配置）
        model: 模型名称（可选，默认使用全局配置）
    
    Returns:
        大纲结构列表
    """
    if not OPENAI_AVAILABLE:
        print("[Content Analyzer] OpenAI 不可用，使用规则引擎生成大纲")
        return generate_outline(text)
    
    try:
        # 创建临时客户端
        temp_client = None
        config = config.config_manager.load_config()
        active_provider = config.get("active_provider", "open-ai") if config else "open-ai"
        provider_config = config.get("providers", {}).get(active_provider, {}) if config else {}
        use_model = model or provider_config.get("default_model", "")
        
        if api_url and api_key:
            temp_client = OpenAI(
                base_url=api_url,
                api_key=api_key,
            )
        elif client is not None:
            temp_client = client
        
        if temp_client is None:
            print("[Content Analyzer] 无可用API客户端，使用规则引擎生成大纲")
            return generate_outline(text)
        
        prompt = f"""请为以下视频字幕文本生成结构化大纲：

{text[:4000]}

要求：
1. 识别主要章节和子章节
2. 为每个章节提供简要内容摘要
3. 使用 Markdown 格式输出，例如：
# 第一章 xxx
内容摘要：xxx

## 1.1 xxx
内容摘要：xxx

## 1.2 xxx
内容摘要：xxx
"""
        
        print(f"[Content Analyzer] 使用模型: {use_model}")
        
        completion = temp_client.chat.completions.create(
            model=use_model,
            messages=[
                {"role": "user", "content": prompt}
            ],
            timeout=60
        )
        
        result = completion.choices[0].message.content.strip()
        
        outline = []
        lines = result.split('\n')
        current_section = None
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            if line.startswith('### '):
                level = 3
                title = line[4:].strip()
            elif line.startswith('## '):
                level = 2
                title = line[3:].strip()
            elif line.startswith('# '):
                level = 1
                title = line[2:].strip()
            elif line.startswith('内容摘要：') or line.startswith('摘要：'):
                if current_section:
                    current_section["content"] = line.replace('内容摘要：', '').replace('摘要：', '').strip()
                continue
            else:
                continue
            
            current_section = {
                "level": level,
                "title": title,
                "content": ""
            }
            outline.append(current_section)
        
        outline = [item for item in outline if item["title"]]
        print("[Content Analyzer] AI 大纲生成成功")
        return outline
    except Exception as e:
        print(f"[Content Analyzer] AI 大纲生成失败: {e}，降级使用规则引擎")
        return generate_outline(text)


def analyze_content(text: str) -> Dict[str, Any]:
    """
    综合分析文本内容，生成总结、笔记和大纲（规则引擎版本）
    
    Args:
        text: 原始文本
    
    Returns:
        分析结果字典
    """
    return {
        "summary": generate_summary(text),
        "notes": generate_notes(text),
        "outline": generate_outline(text)
    }


def analyze_content_ai(text: str) -> Dict[str, Any]:
    """
    综合分析文本内容，生成总结、笔记和大纲（AI 版本）
    
    Args:
        text: 原始文本
    
    Returns:
        分析结果字典
    """
    return {
        "summary": generate_summary_ai(text),
        "notes": generate_notes_ai(text),
        "outline": generate_outline_ai(text)
    }


def analyze_md_file(file_path: str, use_ai: bool = True) -> Dict[str, Any]:
    """
    分析 MD 文件内容
    
    Args:
        file_path: MD 文件路径
        use_ai: 是否使用 AI 分析
    
    Returns:
        分析结果字典
    """
    content = read_md_file(file_path)
    if not content:
        return {"success": False, "error": "文件读取失败或内容为空"}
    
    if use_ai:
        result = analyze_content_ai(content)
    else:
        result = analyze_content(content)
    
    result["success"] = True
    result["source_file"] = file_path
    result["analyzed_at"] = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    
    return result


def _format_summary_md(video_name: str, summary: str, source_file: str) -> str:
    """
    格式化总结为 MD 格式
    """
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    return f"""# 视频总结：{video_name}

{summary}

---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""


def _format_notes_md(video_name: str, notes: List[str], source_file: str) -> str:
    """
    格式化笔记为 MD 格式
    """
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    notes_list = "\n".join([f"- {note}" for note in notes])
    return f"""# 视频笔记：{video_name}

## 关键要点

{notes_list}

---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""


def _format_outline_md(video_name: str, outline: List[Dict[str, Any]], source_file: str) -> str:
    """
    格式化大纲为 MD 格式
    """
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    outline_content = ""
    
    for item in outline:
        level = item["level"]
        title = item["title"]
        content = item.get("content", "")
        
        outline_content += f"{'#' * level} {title}\n\n"
        if content:
            outline_content += f"{content}\n\n"
    
    return f"""# 视频大纲：{video_name}

{outline_content}---

*生成时间：{timestamp}*
*来源文件：{os.path.basename(source_file)}*
"""


def analyze_and_save(video_path: str, md_content: str = None) -> Dict[str, Any]:
    """
    分析视频对应的 MD 内容并保存结果
    
    Args:
        video_path: 视频文件路径
        md_content: 可选，直接提供 MD 内容；如果为 None，自动查找对应字幕文件
    
    Returns:
        分析结果和文件路径
    """
    video_path = Path(video_path)
    video_name = video_path.stem
    video_dir = video_path.parent
    
    if md_content is None:
        subtitle_path = video_dir / f"{video_name}_subtitle.md"
        if subtitle_path.exists():
            md_content = read_md_file(str(subtitle_path))
        else:
            return {"success": False, "error": "未找到字幕文件"}
    
    if not md_content:
        return {"success": False, "error": "MD 内容为空"}
    
    result = analyze_content_ai(md_content)
    
    summary_md = _format_summary_md(video_name, result["summary"], str(video_path))
    notes_md = _format_notes_md(video_name, result["notes"], str(video_path))
    outline_md = _format_outline_md(video_name, result["outline"], str(video_path))
    
    summary_path = video_dir / f"{video_name}_summary.md"
    notes_path = video_dir / f"{video_name}_notes.md"
    outline_path = video_dir / f"{video_name}_outline.md"
    
    summary_ok = write_md_file(str(summary_path), summary_md)
    notes_ok = write_md_file(str(notes_path), notes_md)
    outline_ok = write_md_file(str(outline_path), outline_md)
    
    return {
        "success": True,
        "video_name": video_name,
        "video_dir": str(video_dir),
        "summary_path": str(summary_path) if summary_ok else None,
        "notes_path": str(notes_path) if notes_ok else None,
        "outline_path": str(outline_path) if outline_ok else None,
        "summary": result["summary"],
        "notes": result["notes"],
        "outline": result["outline"],
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    }


if __name__ == "__main__":
    test_text = """这是一个测试视频的字幕内容。

第一章：项目介绍
本项目是一个视频解析工具，可以帮助用户将视频转换为文字，并生成总结和笔记。

1、功能特点
- 支持多种视频格式
- 自动识别语音内容
- 生成智能总结

2、使用方法
首先，上传视频文件。其次，选择输出格式。最后，点击开始转换。

重要提示：请确保视频文件不超过1GB。

结论：这个工具非常实用，可以大大提高工作效率。
"""
    
    print("=== 测试规则引擎分析 ===")
    result_rule = analyze_content(test_text)
    print("总结:", result_rule["summary"])
    print("笔记:", result_rule["notes"])
    print("大纲:", result_rule["outline"])
    
    print("\n=== 测试 AI 分析 ===")
    result_ai = analyze_content_ai(test_text)
    print("总结:", result_ai["summary"])
    print("笔记:", result_ai["notes"])
    print("大纲:", result_ai["outline"])
    
    print("\n=== 测试分析并保存 ===")
    test_video_path = "test_video.mp4"
    save_result = analyze_and_save(test_video_path, test_text)
    print("保存结果:", save_result)