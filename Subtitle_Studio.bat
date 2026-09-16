@echo off
setlocal
set "ROOT=%~dp0"
set "PYTHON=%ROOT%python\python.exe"

if not exist "%PYTHON%" set "PYTHON=python"

echo Starting Subtitle Studio in your browser...
"%PYTHON%" "%ROOT%app\backend\server.py" --port 47821 --ffprobe "%ROOT%ffmpeg\ffprobe.exe" --web-root "%ROOT%app\frontend" --open-browser

endlocal