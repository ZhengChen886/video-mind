import subprocess
import os
import sys
from pathlib import Path


class AudioConverter:
    def __init__(self, ffmpeg_path="ffmpeg"):
        """
        初始化音频转换器
        
        Args:
            ffmpeg_path: FFmpeg可执行文件的路径，默认使用系统PATH中的ffmpeg
        """
        self.ffmpeg_path = ffmpeg_path
        self.supported_formats = ['.webm', '.m4a', '.mp4', '.avi', '.mov', '.wav', '.flac', '.aac']
        
    def check_ffmpeg_installed(self):
        """检查FFmpeg是否已安装"""
        try:
            subprocess.run([self.ffmpeg_path, '-version'], 
                          capture_output=True, 
                          text=True,
                          encoding='utf-8',
                          check=True)
            return True
        except (subprocess.CalledProcessError, FileNotFoundError):
            return False
    
    def convert_to_mp3(self, input_file, output_file=None, bitrate='192k', 
                      sample_rate=44100, remove_original=False):
        """
        将音频/视频文件转换为MP3格式
        
        Args:
            input_file: 输入文件路径
            output_file: 输出文件路径（可选，自动生成）
            bitrate: MP3比特率（默认192k）
            sample_rate: 采样率（默认44100Hz）
            remove_original: 是否删除原始文件（默认False）
        
        Returns:
            bool: 转换是否成功
        """
        # 检查输入文件是否存在
        if not os.path.exists(input_file):
            print(f"错误：输入文件 '{input_file}' 不存在")
            return False
        
        # 检查文件格式是否支持
        file_ext = Path(input_file).suffix.lower()
        if file_ext not in self.supported_formats:
            print(f"警告：文件格式 '{file_ext}' 可能不被支持")
            print(f"支持的格式：{', '.join(self.supported_formats)}")
        
        # 生成输出文件名（如果未提供）
        if output_file is None:
            input_path = Path(input_file)
            output_file = str(input_path.with_suffix('.mp3'))
        
        # 构建FFmpeg命令
        command = [
            self.ffmpeg_path,
            '-i', input_file,          # 输入文件
            '-vn',                     # 禁用视频流
            '-acodec', 'libmp3lame',   # 使用MP3编码器
            '-ab', bitrate,            # 音频比特率
            '-ar', str(sample_rate),   # 采样率
            '-y',                      # 覆盖输出文件
            output_file
        ]
        
        print(f"正在转换: {input_file} → {output_file}")
        print(f"命令: {' '.join(command)}")
        
        try:
            # 执行转换
            result = subprocess.run(command, 
                                  capture_output=True, 
                                  text=True,
                                  encoding='utf-8',
                                  check=True)
            
            print(f"转换成功: {output_file}")
            
            # 如果设置删除原始文件
            if remove_original:
                os.remove(input_file)
                print(f"已删除原始文件: {input_file}")
            
            return True
            
        except subprocess.CalledProcessError as e:
            print(f"转换失败: {e}")
            print(f"错误输出: {e.stderr}")
            return False
    
    def batch_convert(self, input_dir, output_dir=None, 
                     file_extensions=None, **kwargs):
        """
        批量转换目录中的文件
        
        Args:
            input_dir: 输入目录路径
            output_dir: 输出目录路径（可选）
            file_extensions: 要转换的文件扩展名列表（可选）
            **kwargs: 传递给convert_to_mp3的其他参数
        
        Returns:
            dict: 转换结果统计
        """
        if file_extensions is None:
            file_extensions = self.supported_formats
        
        # 确保输入目录存在
        if not os.path.isdir(input_dir):
            print(f"错误：输入目录 '{input_dir}' 不存在")
            return {'success': 0, 'failed': 0, 'total': 0}
        
        # 创建输出目录（如果指定）
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        
        results = {
            'success': 0,
            'failed': 0,
            'total': 0,
            'failed_files': []
        }
        
        # 遍历目录中的文件
        for root, _, files in os.walk(input_dir):
            for file in files:
                file_path = os.path.join(root, file)
                file_ext = Path(file).suffix.lower()
                
                # 检查文件扩展名
                if file_ext in file_extensions:
                    results['total'] += 1
                    
                    # 构建输出路径
                    if output_dir:
                        relative_path = os.path.relpath(root, input_dir)
                        output_subdir = os.path.join(output_dir, relative_path)
                        os.makedirs(output_subdir, exist_ok=True)
                        output_file = os.path.join(output_subdir, 
                                                  Path(file).with_suffix('.mp3'))
                    else:
                        output_file = None
                    
                    # 执行转换
                    success = self.convert_to_mp3(file_path, output_file, **kwargs)
                    
                    if success:
                        results['success'] += 1
                    else:
                        results['failed'] += 1
                        results['failed_files'].append(file_path)
        
        print(f"\n批量转换完成:")
        print(f"总计: {results['total']} 个文件")
        print(f"成功: {results['success']} 个文件")
        print(f"失败: {results['failed']} 个文件")
        
        if results['failed_files']:
            print(f"失败的文件:")
            for file in results['failed_files']:
                print(f"  - {file}")
        
        return results


# ============================================================
# 公共函数：供外部模块导入使用
# ============================================================

def convert_audio_to_mp3(input_path: str, output_path: str, 
                         bitrate: str = '192k', sample_rate: int = 44100) -> bool:
    """
    将音频/视频文件转换为MP3格式（供API调用）
    
    Args:
        input_path: 输入文件路径
        output_path: 输出文件路径
        bitrate: MP3比特率（默认192k）
        sample_rate: 采样率（默认44100Hz）
    
    Returns:
        bool: 转换是否成功
    """
    try:
        # 确保输出目录存在
        output_dir = Path(output_path).parent
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # 构建FFmpeg命令
        cmd = [
            "ffmpeg",
            "-y",                    # 覆盖输出文件
            "-i", input_path,         # 输入文件
            "-vn",                   # 禁用视频
            "-ar", str(sample_rate),  # 采样率
            "-ac", "2",              # 双声道（立体声）
            "-b:a", bitrate,          # 比特率
            "-loglevel", "error",    # 只显示错误
            output_path,              # 输出文件
        ]
        
        print(f"[FFmpeg] 执行命令: {' '.join(cmd)}")
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            timeout=600,  # 10分钟超时
            shell=True    # Windows需要shell=True
        )
        
        if result.returncode == 0 and os.path.exists(output_path):
            print(f"[FFmpeg] 转换成功: {output_path}")
            return True
        else:
            print(f"[FFmpeg Error] 返回码: {result.returncode}")
            print(f"[FFmpeg Error] 错误输出: {result.stderr}")
            return False
            
    except subprocess.TimeoutExpired:
        print("[FFmpeg Error] 转换超时")
        return False
    except Exception as e:
        print(f"[FFmpeg Error] 异常: {e}")
        return False


def main():
    """主函数：演示如何使用音频转换器"""
    converter = AudioConverter()
    
    # 检查FFmpeg是否安装
    if not converter.check_ffmpeg_installed():
        print("错误：FFmpeg未安装或不在PATH中")
        print("请安装FFmpeg：")
        print("  - Windows: 下载并添加到PATH")
        print("  - macOS: brew install ffmpeg")
        print("  - Linux: sudo apt-get install ffmpeg")
        return
    
    print("FFmpeg音频转换器已启动")
    print(f"支持的格式: {', '.join(converter.supported_formats)}")
    
    # 示例1：单个文件转换
    print("\n示例1：单个文件转换")
    input_file = "example.m4a"  # 替换为实际文件路径
    if os.path.exists(input_file):
        converter.convert_to_mp3(input_file, bitrate='320k')
    
    # 示例2：批量转换
    print("\n示例2：批量转换目录")
    input_directory = "videos"  # 替换为实际目录路径
    if os.path.exists(input_directory):
        converter.batch_convert(input_directory, 
                               output_dir="converted_mp3",
                               bitrate='192k')
    
    # 示例3：使用高级参数
    print("\n示例3：高级转换示例")
    advanced_converter = AudioConverter()
    if os.path.exists("input.webm"):  # 替换为实际文件路径
        advanced_converter.convert_to_mp3(
            input_file="input.webm",
            output_file="output_high_quality.mp3",
            bitrate='320k',        # 高质量比特率
            sample_rate=48000,     # 48kHz采样率
            remove_original=False  # 保留原始文件
        )


if __name__ == "__main__":
    main()