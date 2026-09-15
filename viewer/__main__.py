"""Start a paper Stonkfly worker and the 3D viewer together, then open the browser.

Usage: python -m viewer [--out runs/paper] [--port 8765] [--no-worker] [--no-browser]

Paper mode only. Live trading must be started by hand, as docs/operations.md requires.
"""

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from pathlib import Path

from .server import serve
from .state import read_ledger

# The worker resolves its dataset (data/ or STONKFLY_DATA) against its cwd.
ROOT = Path(__file__).resolve().parents[1]
LOCK_MESSAGE = "already owns this run directory"


def worker_env():
    env = dict(os.environ)
    if "SSL_CERT_FILE" not in env:
        try:
            import certifi

            # python.org macOS builds ship without root CAs; Coinbase quotes need them.
            env["SSL_CERT_FILE"] = certifi.where()
        except ImportError:
            pass
    return env


def worker_blocker(out):
    """Return why no paper worker may be started for `out`, or None."""
    if out.resolve().name == "live":
        return "This launcher never starts live trading; showing the viewer only."
    ledger = out / "ledger.sqlite"
    meta = read_ledger(ledger) if ledger.exists() else {"mode": "paper"}
    if meta.get("mode") != "paper":
        # Also covers an unreadable ledger: its mode is unknown, so stay hands-off.
        mode = meta.get("mode", "unreadable")
        return f"This launcher only starts paper runs (ledger mode: {mode}); showing the viewer only."
    if (out / "STOP").exists():
        return f"{out / 'STOP'} exists, so no worker was started. Remove it after review, then relaunch."
    if meta.get("halted"):
        return f"The run is halted ({meta['halted']}); no worker was started. Review it before resuming by hand."
    return None


def start_worker(out):
    # Output goes to an unlinked temp file, not a pipe: if this launcher dies first,
    # a broken pipe would turn the worker's next print into an error that halts the run.
    fd, name = tempfile.mkstemp(prefix="stonkfly-worker-", suffix=".log")
    reader = open(name, "rb")
    os.unlink(name)
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "stonkfly", "run", "--out", str(out.resolve())],
            stdout=fd,
            stderr=subprocess.STDOUT,
            cwd=ROOT,
            env=worker_env(),
            start_new_session=True,  # Ctrl-C is forwarded deliberately, once.
        )
    finally:
        os.close(fd)
    proc.follower = threading.Thread(target=follow, args=(proc, reader), daemon=True)
    proc.follower.start()
    return proc


def follow(proc, reader):
    locked = False
    pending = b""
    with reader:
        while True:
            exited = proc.poll() is not None
            chunk = reader.read()
            *lines, pending = (pending + chunk).split(b"\n")
            for raw in lines:
                line = raw.decode(errors="replace").rstrip()
                if LOCK_MESSAGE in line:
                    locked = True
                    line = "a worker is already running for this run directory; the viewer will follow it"
                print(f"[fly] {line}", flush=True)
            if exited:
                break
            if not chunk:
                time.sleep(0.25)
    if pending.strip():
        print(f"[fly] {pending.decode(errors='replace').rstrip()}", flush=True)
    if not locked:
        note = "" if getattr(proc, "stopping", False) else "; the viewer keeps running"
        print(f"[fly] worker exited ({proc.returncode}){note}", flush=True)


def bind(out, port):
    for candidate in range(port, port + 20):
        try:
            return serve(out, port=candidate), candidate
        except OSError:
            continue
    raise SystemExit(f"No free port in {port}-{port + 19}")


def interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    p = argparse.ArgumentParser(description="Run the Stonkfly paper worker with its 3D viewer")
    p.add_argument("--out", type=Path, default=Path("runs/paper"))
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-worker", action="store_true", help="only start the viewer")
    p.add_argument("--no-browser", action="store_true")
    a = p.parse_args()

    # A shell starts background jobs with SIGINT ignored, and the worker would inherit
    # that. Installing a handler makes both stoppable; closing the terminal or a plain
    # `kill` then stops the worker cleanly instead of orphaning it.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGHUP, interrupt)

    blocker = None if a.no_worker else worker_blocker(a.out)
    if blocker:
        print(f"[fly] {blocker}", flush=True)
    server, port = bind(a.out, a.port)  # Before the worker, so a bind failure orphans nothing.
    worker = None if a.no_worker or blocker else start_worker(a.out)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}"
    print(f"[viewer] {url}", flush=True)
    if not a.no_browser:
        webbrowser.open(url)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        # Signal first: after a terminal hangup, printing can fail.
        running = worker and worker.poll() is None
        if running:
            worker.stopping = True
            worker.send_signal(signal.SIGINT)
        server.shutdown()
        server.server_close()
        print("\n[viewer] stopped", flush=True)
        if running:
            print("[fly] waiting for the worker to finish its current step…", flush=True)
            try:
                worker.wait()
                worker.follower.join(timeout=2)
            except KeyboardInterrupt:
                print(f"[fly] leaving worker {worker.pid} to finish on its own", flush=True)


if __name__ == "__main__":
    main()
