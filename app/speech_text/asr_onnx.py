
import os
import time
import soundfile as sf
import numpy as np
from dataclasses import dataclass



# 设置 ModelScope 和 HuggingFace 缓存目录（使用本地已下载的模型）
os.environ["MODELSCOPE_CACHE"] = r"F:\temp\modelscope"
os.environ["HF_HOME"] = r"F:\temp\modelscope"

# 使用 ModelScope 格式的完整模型路径（有 model.pt）
LOCAL_MODEL_PATH = r"F:\temp\modelscope\models\iic\SenseVoiceSmall"

# ============================================
# 智能分段配置
# ============================================

@dataclass
class SegmentConfig:
    segment_duration: float
    overlap_duration: float
    min_segments: int = 1
    max_segments: int = 200


class AdaptiveAudioSegmenter:
    SEGMENT_STRATEGIES = {
        (0, 180): (45, 1, "超短音频"),
        (180, 600): (60, 2, "短音频"),
        (600, 1800): (90, 3, "中等音频"),
        (1800, 3600): (120, 4, "长音频"),
        (3600, 7200): (150, 5, "超长音频"),
        (7200, float('inf')): (180, 6, "极长音频"),
    }
    
    def __init__(self, target_segments=50, min_segment_duration=10, max_segment_duration=300):
        self.target_segments = target_segments
        self.min_duration = min_segment_duration
        self.max_duration = max_segment_duration
    
    def calculate_segments(self, total_duration_seconds):
        total_minutes = total_duration_seconds / 60
        print(f"音频总时长: {total_duration_seconds:.1f}秒 ({total_minutes:.1f}分钟)")
        print(f"目标分段数: {self.target_segments}")
        
        base_config = self._get_base_strategy(total_duration_seconds)
        adjusted_config = self._adjust_by_target_segments(total_duration_seconds, base_config)
        final_config = self._clamp_to_limits(adjusted_config)
        actual_segments = self._calculate_actual_segments(total_duration_seconds, final_config)
        
        print(f"推荐配置: {final_config.segment_duration:.1f}秒/段, 重叠{final_config.overlap_duration:.1f}秒")
        print(f"预计分段数: {actual_segments}")
        
        return final_config
    
    def _get_base_strategy(self, duration):
        for (min_dur, max_dur), (seg_dur, overlap, desc) in self.SEGMENT_STRATEGIES.items():
            if min_dur <= duration < max_dur:
                print(f"策略选择: {desc}")
                return SegmentConfig(segment_duration=seg_dur, overlap_duration=overlap)
        return SegmentConfig(segment_duration=60, overlap_duration=3)
    
    def _adjust_by_target_segments(self, total_duration, config):
        current_segments = total_duration / config.segment_duration
        if current_segments < self.target_segments * 0.5:
            adjustment = self.target_segments / current_segments
            new_duration = config.segment_duration / adjustment
            new_duration = max(self.min_duration, new_duration)
            overlap_ratio = config.overlap_duration / config.segment_duration
            new_overlap = new_duration * overlap_ratio
            return SegmentConfig(segment_duration=new_duration, overlap_duration=new_overlap)
        elif current_segments > self.target_segments * 1.5:
            adjustment = current_segments / self.target_segments
            new_duration = config.segment_duration * adjustment
            new_duration = min(self.max_duration, new_duration)
            new_overlap = min(config.overlap_duration * 1.2, new_duration * 0.2)
            return SegmentConfig(segment_duration=new_duration, overlap_duration=new_overlap)
        return config
    
    def _clamp_to_limits(self, config):
        segment_duration = max(self.min_duration, min(self.max_duration, config.segment_duration))
        max_overlap = segment_duration * 0.2
        overlap_duration = min(config.overlap_duration, max_overlap)
        overlap_duration = max(0.5, overlap_duration)
        return SegmentConfig(segment_duration=segment_duration, overlap_duration=overlap_duration)
    
    def _calculate_actual_segments(self, total_duration, config):
        if config.segment_duration >= total_duration:
            return 1
        effective_duration = config.segment_duration - config.overlap_duration
        segments = int(np.ceil(total_duration / effective_duration))
        return max(1, segments)
    
    def generate_segments(self, total_duration, config):
        segments = []
        start_time = 0.0
        while start_time < total_duration:
            end_time = min(start_time + config.segment_duration, total_duration)
            if len(segments) > 0 and (end_time - start_time) < self.min_duration:
                prev_start, prev_end = segments[-1]
                segments[-1] = (prev_start, end_time)
                break
            segments.append((start_time, end_time))
            start_time = end_time - config.overlap_duration
        return segments


# ============================================
# 检查 GPU 可用性
# ============================================

HAS_CUDA = False
DEVICE = "cpu"

try:
    import onnxruntime as ort
    providers = ort.get_available_providers()
    print(f"[ASR] ONNX Runtime 可用提供者: {providers}")
    if 'CUDAExecutionProvider' in providers:
        HAS_CUDA = True
        DEVICE = "cuda"
        print(f"[ASR] 检测到 CUDAExecutionProvider，将使用 GPU")
    else:
        print(f"[ASR] 未检测到 CUDAExecutionProvider，使用 CPU")
except ImportError:
    try:
        import torch
        HAS_CUDA = torch.cuda.is_available()
        if HAS_CUDA:
            DEVICE = "cuda"
            print(f"[ASR] 检测到 PyTorch CUDA: {HAS_CUDA}")
    except ImportError:
        pass

print(f"[ASR] 最终使用设备: {DEVICE}")

# 设置 ONNX Runtime 环境变量，优化 GPU 使用
if DEVICE == "cuda":
    os.environ["OMP_NUM_THREADS"] = "8"
    os.environ["ORT_CUDA_USE_GPU_DEFAULT"] = "1"
else:
    os.environ["OMP_NUM_THREADS"] = "8"
    os.environ["OMP_WAIT_POLICY"] = "PASSIVE"


# ============================================
# 全局模型和分段器实例（懒加载）
# ============================================

asr_model = None
segmenter = None
sample_rate = 16000


# ============================================
# 加载模型
# ============================================

def get_asr_model():
    global asr_model
    if asr_model is None:
        from funasr_onnx import SenseVoiceSmall
        print("[ASR] 正在加载语音识别模型(本地路径)...")
        print(f"[ASR] 模型路径: {LOCAL_MODEL_PATH}")
        print(f"[ASR] 使用设备: {DEVICE}")
        
        print("[ASR] 加载模型 (batch_size=8, quantize=True)...")
        asr_model = SenseVoiceSmall(
            model_dir=LOCAL_MODEL_PATH,
            batch_size=8,
            quantize=True,
            hub="ms"
        )
        print("[ASR] 模型加载完成")
    return asr_model


def get_segmenter(target_segments=50):
    global segmenter
    if segmenter is None:
        segmenter = AdaptiveAudioSegmenter(target_segments=target_segments)
    return segmenter


# ============================================
# 音频分段和提取
# ============================================

def get_audio_info(audio_path):
    info = sf.info(audio_path)
    return {
        'duration': info.duration,
        'samplerate': info.samplerate,
        'channels': info.channels,
        'frames': info.frames,
        'file_size': os.path.getsize(audio_path)
    }


def extract_segment(audio_path, start_time, end_time):
    info = sf.info(audio_path)
    samplerate = info.samplerate
    start_sample = int(start_time * samplerate)
    end_sample = int(end_time * samplerate)
    with sf.SoundFile(audio_path) as audio_file:
        audio_file.seek(start_sample)
        segment_data = audio_file.read(end_sample - start_sample, dtype='float32')
    if len(segment_data.shape) > 1:
        segment_data = np.mean(segment_data, axis=1)
    if samplerate != sample_rate:
        from scipy import signal
        num_samples = int(len(segment_data) * sample_rate / samplerate)
        segment_data = signal.resample(segment_data, num_samples)
    return segment_data


def transcribe_segment(segment_data, segment_num):
    from funasr_onnx.utils.postprocess_utils import rich_transcription_postprocess
    # 直接传入 numpy 数组，避免临时文件 IO
    res = asr_model(segment_data, language="auto", textnorm="withitn")
    if res and len(res) > 0:
        text = rich_transcription_postprocess(res[0])
        return text
    return ""


# ============================================
# 公共函数：供外部模块导入使用
# ============================================

def transcribe_audio(audio_path: str, language: str = "auto", progress_callback=None) -> dict:
    """
    使用 SenseVoice 进行语音识别（智能分段 + GPU 加速）
    
    Args:
        audio_path: 音频文件路径
        language: 识别语言，支持 auto/zh/en/yue/ja/ko
        progress_callback: 进度回调函数，格式为 callback(phase, progress, message)
            phase: "loading", "segmenting", "transcribing", "saving"
            progress: 0-100 进度值
            message: 进度消息
    
    Returns:
        dict: 包含识别结果的字典
            - success: 是否成功
            - text: 美化后的识别文本
            - raw_text: 原始识别文本
            - language: 识别的语言
            - saved_path: 保存的md文件路径
    """
    
    def update_progress(phase, progress, message):
        if progress_callback:
            progress_callback(phase, progress, message)
        print(f"[ASR] {message}")
    
    from .gpu_performance_monitor import GPUPerformanceMonitor
    try:
        monitor = GPUPerformanceMonitor(interval=0.5)
        monitor.start_monitoring()
        
        update_progress("loading", 5, "正在加载ASR模型...")
        # 确保模型已加载
        model = get_asr_model()
        
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"音频文件不存在: {audio_path}")
        
        audio_info = get_audio_info(audio_path)
        total_duration = audio_info['duration']
        print(f"[ASR] 处理音频: {os.path.basename(audio_path)}")
        print(f"[ASR] 文件大小: {audio_info['file_size'] / 1024 / 1024:.2f} MB")
        
        update_progress("segmenting", 15, "正在计算分段策略...")
        # 计算分段策略
        seg = get_segmenter(target_segments=50)
        config = seg.calculate_segments(total_duration)
        segments = seg.generate_segments(total_duration, config)
        print(f"[ASR] 实际分段数: {len(segments)}")
        
        update_progress("transcribing", 20, "开始语音识别...")
        results = []
        start_time = time.time()
        
        for i, (seg_start, seg_end) in enumerate(segments):
            seg_num = i + 1
            overall_progress = 20 + (seg_num / len(segments) * 75)
            
            if seg_num % 5 == 0 or seg_num == len(segments):
                elapsed = time.time() - start_time
                eta = (elapsed / seg_num) * (len(segments) - seg_num) if seg_num > 0 else 0
                update_progress(
                    "transcribing",
                    overall_progress,
                    f"正在识别第 {seg_num}/{len(segments)} 段 (已用: {elapsed:.1f}s, 剩余: {eta:.1f}s)"
                )
            
            try:
                segment_data = extract_segment(audio_path, seg_start, seg_end)
                text = transcribe_segment(segment_data, seg_num)
                results.append({
                    'segment': seg_num,
                    'start_time': seg_start,
                    'end_time': seg_end,
                    'text': text
                })
            except Exception as e:
                print(f"[ASR]   [Error] 分段处理失败: {e}")
                results.append({
                    'segment': seg_num,
                    'start_time': seg_start,
                    'end_time': seg_end,
                    'text': "",
                    'error': str(e)
                })
        
        total_time = time.time() - start_time
        final_text = "\n".join([r['text'] for r in results if r['text']])
        
        print(f"[ASR] 处理完成! 总耗时: {total_time:.1f}s")
        print(f"[ASR] 总文本长度: {len(final_text)} 字符")
        
        update_progress("saving", 95, "正在保存识别结果...")
        # 保存结果
        audio_dir = os.path.dirname(audio_path)
        audio_name = os.path.splitext(os.path.basename(audio_path))[0]
        md_filename = f"{audio_name}_subtitle.md"
        md_path = os.path.join(audio_dir, md_filename)
        
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(f"# {audio_name} 字幕\n\n")
            f.write(final_text)
        
        print(f"[ASR] 识别结果已保存到: {md_path}")

        update_progress("saving", 100, "处理完成!")
        monitor.stop_monitoring()
        return {
            "success": True,
            "text": final_text,
            "raw_text": final_text,
            "language": language,
            "saved_path": md_path,
        }
        
    except Exception as e:
        print(f"[ASR Error] 识别失败: {e}")
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "text": "",
            "raw_text": "",
            "language": language,
            "saved_path": "",
            "error": str(e),
        }
