import subprocess
import time
import threading
import psutil
import numpy as np
from datetime import datetime

class GPUPerformanceMonitor:
    """实时GPU性能监控器"""
    
    def __init__(self, interval=1.0):
        self.interval = interval
        self.monitoring = False
        self.stats = {
            'gpu_util': [],
            'gpu_mem': [],
            'cpu_util': [],
            'ram_usage': [],
            'timestamps': []
        }
    
    def start_monitoring(self):
        """开始监控"""
        self.monitoring = True
        self.monitor_thread = threading.Thread(target=self._monitor_loop)
        self.monitor_thread.daemon = True
        self.monitor_thread.start()
        print("🔍 GPU性能监控已启动")
    
    def _monitor_loop(self):
        """监控循环"""
        while self.monitoring:
            try:
                # 获取GPU信息
                result = subprocess.run(
                    ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total', 
                     '--format=csv,noheader,nounits'],
                    capture_output=True,
                    text=True,
                    encoding='utf-8'
                )
                
                if result.returncode == 0:
                    gpu_info = result.stdout.strip().split(',')
                    if len(gpu_info) >= 3:
                        gpu_util = float(gpu_info[0])
                        gpu_mem_used = float(gpu_info[1])
                        gpu_mem_total = float(gpu_info[2])
                        
                        self.stats['gpu_util'].append(gpu_util)
                        self.stats['gpu_mem'].append(gpu_mem_used / gpu_mem_total * 100)
                
                # 获取CPU和内存信息
                cpu_percent = psutil.cpu_percent(interval=0.1)
                ram_percent = psutil.virtual_memory().percent
                
                self.stats['cpu_util'].append(cpu_percent)
                self.stats['ram_usage'].append(ram_percent)
                self.stats['timestamps'].append(datetime.now())
                
                # 实时显示
                if len(self.stats['gpu_util']) > 0:
                    print(f"GPU: {self.stats['gpu_util'][-1]:3.0f}% | "
                          f"显存: {self.stats['gpu_mem'][-1]:5.1f}% | "
                          f"CPU: {cpu_percent:3.0f}% | "
                          f"内存: {ram_percent:3.0f}%", end='\r')
                
            except Exception as e:
                print(f"监控错误: {e}")
            
            time.sleep(self.interval)
    
    def stop_monitoring(self):
        """停止监控"""
        self.monitoring = False
        if hasattr(self, 'monitor_thread'):
            self.monitor_thread.join(timeout=2)
        
        print("📊 监控结果统计:")
        if self.stats['gpu_util']:
            print(f"GPU平均利用率: {np.mean(self.stats['gpu_util']):.1f}%")
            print(f"GPU最大利用率: {np.max(self.stats['gpu_util']):.1f}%")
            print(f"GPU显存平均使用: {np.mean(self.stats['gpu_mem']):.1f}%")
        else:
            print("未获取到GPU数据，请检查nvidia-smi")
        
        return self.stats

# 使用监控
# monitor = GPUPerformanceMonitor(interval=0.5)
# monitor.start_monitoring()

# 在您的处理代码前后调用
# monitor.stop_monitoring()
