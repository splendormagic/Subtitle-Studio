@echo off
setlocal
set "ROOT=%~dp0"
set "PYTHON=%ROOT%python\python.exe"
set "FFMPEG_DIR=%ROOT%ffmpeg"
set "FFMPEG_ZIP=%TEMP%\Subtitle_Studio_ffmpeg-tools.zip"
set "FFMPEG_EXE=%FFMPEG_DIR%\ffmpeg.exe"
set "FFPROBE_EXE=%FFMPEG_DIR%\ffprobe.exe"
set "FFMPEG_URL=https://github.com/splendormagic/Subtitle-Studio/releases/download/v1.1.0/ffmpeg-tools.zip"

if not exist "%PYTHON%" set "PYTHON=python"

if not exist "%FFMPEG_EXE%" goto download_tools
if exist "%FFMPEG_EXE%\NUL" goto download_tools
if not exist "%FFPROBE_EXE%" goto download_tools
if exist "%FFPROBE_EXE%\NUL" goto download_tools
goto start_app

:download_tools
echo Downloading FFmpeg tools...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; New-Item -ItemType Directory -Force -Path '%FFMPEG_DIR%' | Out-Null; Invoke-WebRequest -Uri '%FFMPEG_URL%' -OutFile '%FFMPEG_ZIP%'; $extract = Join-Path $env:TEMP 'Subtitle_Studio_ffmpeg-tools'; if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }; Expand-Archive -Path '%FFMPEG_ZIP%' -DestinationPath $extract -Force; Copy-Item (Join-Path $extract 'ffmpeg-tools\*.exe') '%FFMPEG_DIR%' -Force; Remove-Item $extract -Recurse -Force; Remove-Item '%FFMPEG_ZIP%' -Force"
if errorlevel 1 (
	echo Failed to download or extract FFmpeg tools.
	echo Check your internet connection and try again.
	exit /b 1
)

:verify_tools
if not exist "%FFMPEG_EXE%" goto tools_invalid
if exist "%FFMPEG_EXE%\NUL" goto tools_invalid
if not exist "%FFPROBE_EXE%" goto tools_invalid
if exist "%FFPROBE_EXE%\NUL" goto tools_invalid
goto start_app

:tools_invalid
echo FFmpeg tools are missing or invalid.
echo Expected files: "%FFMPEG_EXE%" and "%FFPROBE_EXE%"
exit /b 1

:start_app
echo Starting Subtitle Studio in your browser...
"%PYTHON%" "%ROOT%app\backend\server.py" --port 47821 --ffprobe "%FFPROBE_EXE%" --web-root "%ROOT%app\frontend" --open-browser

endlocal