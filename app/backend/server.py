import argparse
import json
import mimetypes
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

TIME_PATTERN = re.compile(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})")
APP_VERSION = "1.1.0"


def parse_time(value):
    match = TIME_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value}")
    hours, minutes, seconds, milliseconds = (int(part) for part in match.groups())
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds


def format_time(milliseconds):
    milliseconds = max(0, int(round(milliseconds)))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def parse_srt(text):
    entries = []
    blocks = re.split(r"\r?\n\s*\r?\n", text.replace("\ufeff", "").strip())
    for position, block in enumerate(blocks, 1):
        lines = block.splitlines()
        if len(lines) < 2:
            continue
        timing_line_index = 1 if lines[0].strip().isdigit() else 0
        if " --> " not in lines[timing_line_index]:
            continue
        start, end = lines[timing_line_index].split(" --> ", 1)
        entries.append({
            "id": len(entries) + 1,
            "start": parse_time(start),
            "end": parse_time(end.split()[0]),
            "text": "\n".join(lines[timing_line_index + 1:]).strip(),
        })
    return entries


def render_srt(entries):
    blocks = []
    for index, entry in enumerate(entries, 1):
        start = min(entry["start"], entry["end"] - 1)
        end = max(entry["end"], start + 1)
        blocks.append(f"{index}\n{format_time(start)} --> {format_time(end)}\n{entry['text'].strip()}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


class Handler(BaseHTTPRequestHandler):
    server_version = "SubtitleStudioBackend/1.0"

    def do_GET(self):
        request_path = urlparse(self.path).path
        if request_path == "/health":
            self.send_json({"ok": True, "version": self.server.version_name})
        else:
            self.send_static(request_path)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/parse-srt":
                self.send_json({"entries": parse_srt(payload.get("text", ""))})
            elif self.path == "/render-srt":
                self.send_json({"text": render_srt(payload.get("entries", []))})
            elif self.path == "/probe-audio":
                self.send_json({"metadata": probe_audio(payload["path"])})
            else:
                self.send_error(404)
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
        except Exception as error:
            self.send_json({"error": str(error)}, 500)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, request_path):
        relative_path = unquote(request_path.lstrip("/")) or "index.html"
        file_path = (self.server.web_root / relative_path).resolve()
        if self.server.web_root not in file_path.parents or not file_path.is_file():
            self.send_error(404)
            return
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


def probe_audio(file_path):
    command = [
        Handler.server.ffprobe, "-v", "error", "-show_entries",
        "format=duration:stream=codec_name,sample_rate,channels", "-of", "json", file_path
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--version")
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--web-root", required=True)
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.version_name = args.version or APP_VERSION
    server.ffprobe = str(Path(args.ffprobe))
    server.web_root = Path(args.web_root).resolve()
    Handler.server = server
    if args.open_browser:
        import webbrowser
        webbrowser.open(f"http://127.0.0.1:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
