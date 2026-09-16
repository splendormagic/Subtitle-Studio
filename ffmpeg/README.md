The launcher downloads the native FFmpeg tools used by the browser-mode backend into this folder:

- Windows: `ffmpeg.exe`
- macOS/Linux: `ffmpeg`

The batch launcher passes `ffprobe.exe` from this folder to the Python backend. The download source is the project's GitHub release. Choose and distribute an FFmpeg build whose license terms fit the application before shipping.
