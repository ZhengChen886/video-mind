<div style="display: flex; justify-content: center; align-items: center; gap: 10px;">
  <h1 align="center">🎬 AI 视频笔记助手</h1>
</div>

<p align="center"><i>智能视频管理与 AI 内容分析工具 让 AI 为你的视频做笔记</i></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" />
  <img src="https://img.shields.io/badge/backend-fastapi-green" />
  <img src="https://img.shields.io/badge/frontend-html5-orange" />
  <img src="https://img.shields.io/badge/status-active-success" />
</p>

## ✨ 项目简介

VideoMind 是一个功能强大的本地视频管理与 AI 内容分析工具，支持视频上传、语音识别、AI 总结、笔记生成等功能，让你的视频内容学习与管理更加高效。

> 💡 **特点**: 纯本地部署、数据安全、无需云端依赖、开箱即用

## 🚀 功能特性

- 📺 **多源视频导入**：支持本地视频上传、链接下载（m3u8、mp4 等格式）
- 🎵 **智能语音识别**：基于 FunASR-ONNX 模型，精准转写视频音频
- 🧠 **AI 内容分析**：自动生成视频总结、知识笔记、内容大纲
- 📂 **文件管理系统**：支持视频分类、重命名、移动、删除等操作
- 📋 **任务管理系统**：批量处理、实时进度、任务历史查看
- 🔧 **多模型配置**：支持自定义 AI 模型供应商（Free AI、OpenRoute、NVIDIA 等）
- ✨ **美观界面**：现代化 UI 设计，流畅的用户体验
- 📝 **文档管理**：支持 Markdown、PDF、Word 等文档查看

## 📸 界面预览

### 首页仪表盘

简洁直观的首页，快速访问核心功能

### 视频管理

卡片式与列表式双视图，支持批量操作

### 智能分析

自动转录、总结、生成笔记，一键完成

## 🛠️ 技术栈

| 类别        | 技术                        |
| --------- | ------------------------- |
| **后端**    | FastAPI + Uvicorn         |
| **前端**    | HTML5 + CSS3 + JavaScript |
| **视频处理**  | FFmpeg                    |
| **语音识别**  | FunASR-ONNX               |
| **AI 引擎** | OpenAI API 兼容接口           |
| **模板引擎**  | Jinja2                    |

## 📦 快速开始

### 环境要求

- **操作系统**: Windows 10/11 或 Linux
- **Python 版本**: 3.10 或更高
- **内存**: 8GB 以上（推荐 16GB+）
- **存储空间**: 10GB 以上

### 安装步骤

1. **克隆或下载项目**

```bash
cd video-mind
```

1. **安装依赖**

```bash
pip install -r requirements.txt
```

1. **安装 FFmpeg**

- Windows: 从 [FFmpeg 官网](https://ffmpeg.org/download.html) 下载并添加到系统 PATH
- Linux/Mac:

```bash
# Ubuntu/Debian
sudo apt install ffmpeg
# Mac (Homebrew)
brew install ffmpeg
```

1. **启动服务**

```bash
# Windows
python server.py
# 或双击 start_with.bat

# Linux/Mac
python3 server.py
```

1. **访问应用**
   打开浏览器访问: <http://localhost:8000>

## 📂 项目结构

```
video-mind/
├── server.py                    # FastAPI 主服务器
├── requirements.txt             # Python 依赖
├── README.md                    # 项目说明文档
├── start_with.bat               # Windows 启动脚本
│
├── config/                      # 配置目录
│   ├── config.json             # 应用配置
│   └── config_manager.py       # 配置管理模块
│
├── web/                         # 前端资源
│   ├── templates/
│   │   └── index.html          # 主页面
│   └── static/
│       ├── css/
│       │   └── main.css        # 主样式文件
│       └── js/
│           └── app.js          # 前端逻辑
│
├── app/                         # 业务逻辑模块
│   ├── file_operations/        # 文件操作模块
│   │   ├── file_manager.py    # 文件管理（移动、重命名、删除）
│   │   ├── video_processor.py # 视频处理（转音频、缩略图）
│   │   └── audio_converter.py # 音频转换
│   ├── speech_text/            # 语音文字转换模块
│   │   └── asr_onnx.py        # 语音转文字 (FunASR ONNX)
│   ├── text_summary/           # 文字总结模块
│   │   └── content_analyzer.py # 内容分析和总结
│   ├── knowledge/              # 知识库模块
│   │   ├── conversations/     # 对话历史
│   │   └── files/            # 知识文件
│   ├── models/                # 数据模型
│   │   └── knowledge.py
│   ├── rag/                   # RAG 模块
│   │   ├── chat_service.py   # 聊天服务
│   │   ├── vector_store.py   # 向量存储
│   │   └── prompts.py        # 提示词模板
│   ├── repositories/          # 数据仓储
│   │   └── knowledge_repo.py
│   ├── routes/                # API 路由
│   │   ├── knowledge.py      # 知识库路由
│   │   └── dashboard.py      # 仪表盘路由
│   └── services/             # 业务服务
│       ├── knowledge_service.py
│       └── dashboard_service.py
│
├── vector_db/                   # 向量数据库
│   └── chroma.sqlite3
│
└── file_operations/mp4/        # 视频文件存储目录
    ├── 个人收藏/
    └── ...
```

## 🎯 主要功能详解

### 1. 视频管理

- ✅ 本地视频文件上传
- ✅ 链接下载（支持 m3u8、mp4 等格式）
- ✅ 文件夹管理（新建、删除）
- ✅ 文件操作（重命名、移动、删除）
- ✅ 双视图切换（卡片/列表）
- ✅ 视频搜索

### 2. 视频处理

- ✅ 自动提取视频缩略图
- ✅ 视频转音频
- ✅ 智能语音识别 (FunASR-ONNX)
- ✅ 视频信息展示（时长、大小）

### 3. AI 内容分析

- ✅ 视频内容总结生成
- ✅ 知识点笔记提取
- ✅ 内容大纲结构化
- ✅ Markdown 格式渲染
- ✅ 多模型供应商配置

### 4. 任务管理

- ✅ 批量视频处理
- ✅ 实时进度显示
- ✅ 任务历史查看
- ✅ 失败任务重试
- ✅ 下载进度美化

### 5. 文档管理

- ✅ Markdown 文件查看
- ✅ PDF、Word 等文档展示
- ✅ 按文档类型筛选

## 🔧 配置说明

### AI 模型配置

首次使用需要配置 AI 模型供应商：

1. 点击首页右上角用户区域
2. 选择「模型选择」或「API 设置」
3. 添加/配置你的模型供应商（支持 Free AI、OpenRoute、NVIDIA 等）

### 语音识别配置

系统默认使用 FunASR-ONNX 进行本地语音识别，首次使用会自动下载模型（约 100-500MB）。

## 📝 使用指南

### 上传视频

1. 点击「上传视频」按钮
2. 选择本地视频文件或输入视频链接
3. 选择目标文件夹
4. 点击确认开始上传/下载

### 分析视频

1. 在视频列表中点击要分析的视频
2. 点击右侧详情面板中的「视频转录」
3. 等待语音识别完成
4. 点击「生成总结」、「生成笔记」或「生成大纲」

### 批量处理

1. 在视频列表中勾选要处理的视频
2. 点击「批量转录」按钮
3. 在任务列表中查看进度

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

## 📜 License

MIT License

***

💬 如果你觉得这个项目对你有帮助，欢迎 Star ⭐️ 支持！

如有问题，请提交 Issue 反馈。
