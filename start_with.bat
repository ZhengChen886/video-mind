@echo off
chdir /d "%~dp0"

echo Starting AI Video Analysis App...
echo.

REM 设置 Python IO 编码为 UTF-8
set PYTHONIOENCODING=utf-8

REM 启动后端服务（FastAPI - 同时提供后端API和前端页面
echo Starting server on port 8000...
echo Backend API and Frontend will be available on:
echo   - API:       http://localhost:8000
echo   - Frontend:  http://localhost:8000
echo.

REM 启动服务
python server.py