@echo off
REM ============================================================
REM  video-mind launcher
REM  - All paths loaded from config\app_paths.json
REM    (python.exe / ffmpeg.bin_dir / modelscope cache + model)
REM  - First run: locate python via `where python`, or prompt
REM  - Final `pause` keeps the window open on success or error
REM ============================================================
chdir /d "%~dp0"
chcp 65001 >nul 2>&1
set PYTHONIOENCODING=utf-8

set "CONFIG_FILE=%~dp0config\app_paths.json"
set "TMP_ENV=%TEMP%\vm_env_%RANDOM%.bat"
set PYTHON_EXE=
set BOOTSTRAP_PY=
set FFMPEG_DIR=
set MODELSCOPE_CACHE=
set HF_HOME=
set ASR_MODEL_DIR=

REM --- Step 1: bootstrap a Python interpreter from PATH ---
for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined BOOTSTRAP_PY set "BOOTSTRAP_PY=%%P"
)
if defined BOOTSTRAP_PY goto :have_bootstrap_python

if exist "%CONFIG_FILE%" (
    echo [ERROR] Config file exists but `where python` returned nothing.
    echo         Add Python to PATH, or delete %CONFIG_FILE% to reconfigure.
    goto :fail
)

echo ============================================================
echo  First run: Python interpreter not found in PATH.
echo  Please enter the full path of python.exe
echo  Example: F:\Python312\python.exe
echo ============================================================
set /p BOOTSTRAP_PY="Python path: "
if "%BOOTSTRAP_PY%"=="" goto :fail
if not exist "%BOOTSTRAP_PY%" (
    echo [ERROR] Path not found: %BOOTSTRAP_PY%
    goto :fail
)

:have_bootstrap_python
echo [Python] %BOOTSTRAP_PY%

REM --- Step 2: if JSON does not exist, ask and create ---
if exist "%CONFIG_FILE%" goto :emit_env

echo ============================================================
echo  First run configuration
echo ============================================================
echo  Detected Python: %BOOTSTRAP_PY%
set /p PYTHON_CONFIRM="Press Enter to use this Python, or enter a new path: "
if "%PYTHON_CONFIRM%"=="" (
    set "PYTHON_EXE=%BOOTSTRAP_PY%"
) else (
    if not exist "%PYTHON_CONFIRM%" (
        echo [ERROR] Path not found: %PYTHON_CONFIRM%
        goto :fail
    )
    set "PYTHON_EXE=%PYTHON_CONFIRM%"
)

echo  Enter FFmpeg bin directory (leave empty to use system PATH):
set /p FFMPEG_INPUT="FFmpeg directory: "

"%BOOTSTRAP_PY%" -c "import json,os,sys; c={'python':{'exe':sys.argv[1]},'ffmpeg':{'bin_dir':sys.argv[2]},'modelscope':{'cache_dir':r'F:\tmp\temp\modelscope','hf_home':r'F:\tmp\temp\modelscope','asr_model_dir':r'F:\tmp\temp\modelscope\models\iic\SenseVoiceSmall'}}; os.makedirs(os.path.dirname(sys.argv[3]),exist_ok=True); open(sys.argv[3],'w',encoding='utf-8').write(json.dumps(c,ensure_ascii=False,indent=2))" "%PYTHON_EXE%" "%FFMPEG_INPUT%" "%CONFIG_FILE%"
if errorlevel 1 goto :fail
echo [Done] Config written to %CONFIG_FILE%
echo.

:emit_env
REM --- Step 3: read JSON, emit set commands to a temp .bat ---
"%BOOTSTRAP_PY%" -c "import json,sys; c=json.load(open(sys.argv[1],'r',encoding='utf-8')); p=c.get('python',{}).get('exe',''); f=c.get('ffmpeg',{}).get('bin_dir',''); m=c.get('modelscope',{}); r=c.get('rag',{}); print('set \"PYTHON_EXE=%%s\"' %% p); print('set \"FFMPEG_DIR=%%s\"' %% f); print('set \"MODELSCOPE_CACHE=%%s\"' %% m.get('cache_dir','')); print('set \"HF_HOME=%%s\"' %% m.get('hf_home','')); print('set \"ASR_MODEL_DIR=%%s\"' %% m.get('asr_model_dir','')); print('set \"EMBEDDING_DIR=%%s\"' %% r.get('embedding_model','')); print('set \"RERANKER_DIR=%%s\"' %% r.get('reranker_model',''))" "%CONFIG_FILE%" 1>"%TMP_ENV%" 2>nul
if errorlevel 1 (
    echo [ERROR] Failed to read config: %CONFIG_FILE%
    echo         Config file may be malformed. Delete it and re-run to reconfigure.
    goto :fail
)
call "%TMP_ENV%"
del "%TMP_ENV%" >nul 2>&1

REM --- Step 4: validate all configured paths ---
if not defined PYTHON_EXE (
    echo [ERROR] python.exe path missing in %CONFIG_FILE%
    echo         Delete %CONFIG_FILE% and re-run to reconfigure.
    goto :fail
)
if not exist "%PYTHON_EXE%" (
    echo [ERROR] python.exe not found: %PYTHON_EXE%
    echo         Update %CONFIG_FILE% python.exe, or delete it and re-run.
    goto :fail
)

if defined FFMPEG_DIR if not "%FFMPEG_DIR%"=="" (
    if not exist "%FFMPEG_DIR%\ffmpeg.exe" (
        echo [ERROR] ffmpeg.exe not found in: %FFMPEG_DIR%
        echo         Update %CONFIG_FILE% ffmpeg.bin_dir, or clear it to use system PATH.
        goto :fail
    )
)

if defined MODELSCOPE_CACHE if not "%MODELSCOPE_CACHE%"=="" (
    if not exist "%MODELSCOPE_CACHE%" (
        echo [WARN] ModelScope cache dir does not exist: %MODELSCOPE_CACHE%
        echo        It will be auto-created on first use.
    )
)
if defined ASR_MODEL_DIR if not "%ASR_MODEL_DIR%"=="" (
    if not exist "%ASR_MODEL_DIR%" (
        echo [WARN] ASR model dir does not exist: %ASR_MODEL_DIR%
        echo        Model will be auto-downloaded on first use.
    )
)

REM --- Step 5: prepend FFmpeg bin to PATH ---
if defined FFMPEG_DIR if not "%FFMPEG_DIR%"=="" set "PATH=%FFMPEG_DIR%;%PATH%"

echo ============================================================
echo  Starting server on port 8000 ...
echo    - API:       http://localhost:8000
echo    - Frontend:  http://localhost:8000
echo  Python:      %PYTHON_EXE%
if defined FFMPEG_DIR if not "%FFMPEG_DIR%"=="" echo  FFmpeg:      %FFMPEG_DIR%\ffmpeg.exe
if defined MODELSCOPE_CACHE if not "%MODELSCOPE_CACHE%"=="" echo  ModelScope:  %MODELSCOPE_CACHE%
if defined ASR_MODEL_DIR if not "%ASR_MODEL_DIR%"=="" echo  ASR Model:   %ASR_MODEL_DIR%
if defined EMBEDDING_DIR if not "%EMBEDDING_DIR%"=="" echo  Embedding:   %EMBEDDING_DIR%
if defined RERANKER_DIR if not "%RERANKER_DIR%"=="" echo  Reranker:    %RERANKER_DIR%
echo ============================================================
echo  Logs will be printed directly to this console.
echo.

"%PYTHON_EXE%" -u server.py
set "RC=%errorlevel%"
echo.
echo === server.py exited with code: %RC% ===
goto :end

:fail
echo.
echo === Startup FAILED ===

:end
if exist "%TMP_ENV%" del "%TMP_ENV%" >nul 2>&1
echo.
echo Press any key to close this window ...
pause >nul
