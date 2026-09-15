"""Read a run directory without ever writing to it or taking its worker lock."""

import json
import os
import sqlite3
import threading
import time
from collections import deque
from pathlib import Path

LEDGER_KEYS = ("mode", "tick", "cash", "positions", "initial_cash", "anchor", "halted")
# A tick is written every ~60 s; allow for slow neural integration before "idle".
STALE_SECONDS = 180
EVENT_LIMIT = 300


def parse_lines(data):
    rows = []
    for line in data.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue  # A torn or foreign line; never fatal for the display.
        if isinstance(row, dict):
            rows.append(row)
    return rows


def all_events(path):
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError:
        return []
    # The worker may be mid-write; an incomplete last line is picked up on the next poll.
    return parse_lines(data)


def read_events(path, since=0, limit=EVENT_LIMIT, rows=None):
    """Return complete event rows with tick > since, newest `limit` kept."""
    rows = all_events(path) if rows is None else rows
    return [r for r in rows if r.get("tick", 0) > since][-limit:]


class EventTail:
    """Follow events.jsonl incrementally, keeping only the newest rows in memory.

    Re-reading a long run's whole file on every poll costs ~200 ms per 20k ticks.
    """

    def __init__(self, path, keep=EVENT_LIMIT):
        self.path = Path(path)
        self.keep = keep
        self.lock = threading.Lock()
        self.reset(None)

    def reset(self, identity):
        self.identity = identity
        self.offset = 0
        self.last_line = b""
        self.rows = deque(maxlen=self.keep)

    def read(self):
        with self.lock:
            try:
                f = self.path.open("rb")
            except FileNotFoundError:
                self.reset(None)
                return []
            with f:
                st = os.fstat(f.fileno())
                identity = (st.st_dev, st.st_ino)
                if identity != self.identity or st.st_size < self.offset or not self.unchanged(f):
                    self.reset(identity)  # Replaced, truncated or rewritten: start over.
                f.seek(self.offset)
                data = f.read()
            end = data.rfind(b"\n") + 1  # Complete lines only; a partial tail waits.
            if end:
                self.rows.extend(parse_lines(data[:end]))
                self.last_line = data[data.rfind(b"\n", 0, end - 1) + 1 : end]
                self.offset += end
            return list(self.rows)

    def unchanged(self, f):
        # The last line read must still end at the offset, or the file was rewritten.
        f.seek(self.offset - len(self.last_line))
        return f.read(len(self.last_line)) == self.last_line


_tails = {}
_tails_lock = threading.Lock()


def tail_events(path):
    path = Path(path).resolve()
    with _tails_lock:
        tail = _tails.setdefault(path, EventTail(path))
    return tail.read()


def read_ledger(path):
    path = Path(path)
    if not path.exists():
        return {}
    # as_uri() percent-encodes the path: a raw '#' or '?' would truncate the URI,
    # drop mode=ro and let sqlite create a database file somewhere else.
    uri = path.resolve().as_uri() + "?mode=ro"
    if not path.with_name(path.name + "-wal").exists():
        # No worker has the ledger open, so nothing is uncheckpointed. A plain
        # read-only open would still create -wal/-shm files in the run directory.
        uri += "&immutable=1"
    try:
        db = sqlite3.connect(uri, uri=True, timeout=2)
    except sqlite3.Error:
        return {}
    try:
        return {k: json.loads(v) for k, v in db.execute("SELECT key,value FROM meta")}
    except (sqlite3.Error, ValueError):
        return {}
    finally:
        db.close()


def read_state(out, since=0, now=None):
    out = Path(out)
    now = time.time() if now is None else now
    meta = read_ledger(out / "ledger.sqlite")
    rows = tail_events(out / "events.jsonl")
    events = read_events(None, since, rows=rows)
    last_time = rows[-1].get("wall_time") if rows else None

    if not meta:
        status = "waiting"
    elif (out / "STOP").exists():
        status = "stopped"
    elif meta.get("halted"):
        status = "halted"
    elif last_time and now - last_time > STALE_SECONDS:
        status = "idle"
    else:
        status = "running"

    observation = meta.get("observation") or {}
    input_png = out / "latest-input.png"
    return {
        "status": status,
        "now": now,
        "portfolio": {k: meta.get(k) for k in LEDGER_KEYS},
        "history": observation.get("market_history") or {},
        "events": events,
        "last_event_time": last_time,
        "input_version": input_png.stat().st_mtime if input_png.exists() else None,
    }
