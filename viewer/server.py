"""Local HTTP server for the 3D viewer. Serves static files and read-only run state."""

import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .state import read_state

STATIC = Path(__file__).parent / "static"
# Mirrors stonkfly.config.Settings.decoder_threshold_hz; importing the trading
# package here would pull its dependencies into a read-only display process.
DECODER_THRESHOLD_HZ = 2


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, run_dir, **kwargs):
        self.run_dir = run_dir
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/state":
            try:
                since = int(parse_qs(url.query).get("since", ["0"])[0])
            except ValueError:
                since = 0
            state = read_state(self.run_dir, since)
            state["run_dir"] = str(self.run_dir)
            state["decoder_threshold_hz"] = DECODER_THRESHOLD_HZ
            return self.send_bytes(json.dumps(state).encode(), "application/json")
        if url.path == "/api/input.png":
            png = self.run_dir / "latest-input.png"
            if not png.exists():
                return self.send_error(404, "No input frame yet")
            return self.send_bytes(png.read_bytes(), "image/png")
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith("/api/"):
            # Revalidate static files (cheap 304s) so an edited viewer loads on refresh.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # Polling every two seconds would flood the terminal.


def serve(run_dir, host="127.0.0.1", port=8765):
    handler = partial(Handler, run_dir=Path(run_dir).resolve())
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main():
    p = argparse.ArgumentParser(description="Stonkfly 3D viewer (read-only)")
    p.add_argument("--out", type=Path, default=Path("runs/paper"))
    p.add_argument("--port", type=int, default=8765)
    a = p.parse_args()
    server = serve(a.out, port=a.port)
    print(f"Viewer on http://127.0.0.1:{a.port}  (run dir: {a.out})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
