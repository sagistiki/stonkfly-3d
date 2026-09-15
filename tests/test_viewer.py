import json
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from viewer.__main__ import follow, worker_blocker  # noqa: E402
from viewer.server import serve  # noqa: E402
from viewer.state import EventTail, read_events, read_ledger, read_state  # noqa: E402


def row(tick, side="HOLD"):
    return {
        "tick": tick,
        "quote": {"bid": "100", "ask": "101"},
        "neural": {"side": side},
        "execution": {"status": side},
    }


def write_events(path, rows, tail=""):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows) + tail)


def test_missing_run_directory_is_waiting(tmp_path):
    state = read_state(tmp_path / "nope", since=0)
    assert state["status"] == "waiting"
    assert state["events"] == []


def test_events_since_filters_and_skips_partial_line(tmp_path):
    write_events(tmp_path / "events.jsonl", [row(1), row(2), row(3)], '{"tick": 4, "que')
    events = read_events(tmp_path / "events.jsonl", since=1)
    assert [e["tick"] for e in events] == [2, 3]


def test_events_are_capped_to_most_recent(tmp_path):
    write_events(tmp_path / "events.jsonl", [row(i) for i in range(1, 11)])
    events = read_events(tmp_path / "events.jsonl", since=0, limit=3)
    assert [e["tick"] for e in events] == [8, 9, 10]


def test_stale_run_is_idle_even_without_new_events(tmp_path):
    db = sqlite3.connect(tmp_path / "ledger.sqlite")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    db.execute("INSERT INTO meta VALUES ('tick', '1')")
    db.commit()
    db.close()
    write_events(tmp_path / "events.jsonl", [{**row(1), "wall_time": 1000.0}])
    state = read_state(tmp_path, since=1, now=5000.0)
    assert state["status"] == "idle"
    assert state["events"] == []
    assert state["last_event_time"] == 1000.0


def test_state_reads_ledger_read_only(tmp_path):
    db = sqlite3.connect(tmp_path / "ledger.sqlite")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    meta = {
        "mode": "paper",
        "tick": 3,
        "cash": "80.5",
        "positions": {"BTC-USDC": "0.0002"},
        "initial_cash": "100",
        "halted": None,
        "observation": {"market_history": {"BTC-USDC": [1.0, 2.0, 3.0]}},
    }
    db.executemany("INSERT INTO meta VALUES (?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
    db.commit()
    db.close()
    write_events(tmp_path / "events.jsonl", [row(1, "BUY")])
    (tmp_path / "STOP").touch()

    state = read_state(tmp_path, since=0)

    assert state["status"] == "stopped"
    assert state["portfolio"]["cash"] == "80.5"
    assert state["portfolio"]["positions"] == {"BTC-USDC": "0.0002"}
    assert state["history"] == {"BTC-USDC": [1.0, 2.0, 3.0]}
    assert [e["tick"] for e in state["events"]] == [1]


def wal_ledger(path, **meta):
    db = sqlite3.connect(path, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    db.executemany("INSERT INTO meta VALUES (?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
    return db


def test_ledger_read_never_creates_files_in_run_dir(tmp_path):
    run = tmp_path / "odd #name?x %41"  # URI metacharacters must not break mode=ro
    run.mkdir()
    wal_ledger(run / "ledger.sqlite", mode="paper", tick=4).close()
    assert read_ledger(run / "ledger.sqlite") == {"mode": "paper", "tick": 4}
    assert sorted(p.name for p in tmp_path.rglob("*")) == ["ledger.sqlite", run.name]


def test_ledger_read_sees_commits_while_worker_holds_wal(tmp_path):
    writer = wal_ledger(tmp_path / "ledger.sqlite", tick=1)
    try:
        writer.execute("BEGIN IMMEDIATE")
        writer.execute("UPDATE meta SET value='2' WHERE key='tick'")
        assert read_ledger(tmp_path / "ledger.sqlite") == {"tick": 1}
        writer.execute("COMMIT")
        assert read_ledger(tmp_path / "ledger.sqlite") == {"tick": 2}
    finally:
        writer.close()


def test_event_tail_follows_appends_partial_lines_and_replacement(tmp_path):
    path = tmp_path / "events.jsonl"
    tail = EventTail(path, keep=3)
    assert tail.read() == []
    write_events(path, [row(1), row(2)], '{"tick": 3, "que')
    assert [r["tick"] for r in tail.read()] == [1, 2]
    with path.open("a") as f:
        f.write('ue": {}}\n' + json.dumps(row(4)) + "\n" + json.dumps(row(5)) + "\n")
    assert [r["tick"] for r in tail.read()] == [3, 4, 5]  # capped to keep=3

    replacement = tmp_path / "new.jsonl"
    write_events(replacement, [row(1)])
    replacement.replace(path)
    assert [r["tick"] for r in tail.read()] == [1]

    write_events(path, [row(7), row(8)])  # rewritten in place, longer than before
    assert [r["tick"] for r in tail.read()] == [7, 8]


def get(port, path):
    try:
        with urlopen(f"http://127.0.0.1:{port}{path}") as res:
            return res.status, res.read()
    except HTTPError as e:
        return e.code, b""


def test_server_is_local_read_only_and_confined_to_static(tmp_path):
    write_events(tmp_path / "events.jsonl", [row(1), row(2)])
    server = serve(tmp_path, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address
    try:
        assert host == "127.0.0.1"
        for since, ticks in (("abc", [1, 2]), ("-5", [1, 2]), ("1", [2]), ("9" * 5000, [1, 2])):
            status, body = get(port, f"/api/state?since={since}")
            assert status == 200
            assert [e["tick"] for e in json.loads(body)["events"]] == ticks
        for escape in ("/../state.py", "/%2e%2e/state.py", "/..%2fserver.py", "/js/../../server.py"):
            assert get(port, escape)[0] == 404
        assert get(port, "/api/input.png")[0] == 404
        assert get(port, "/")[0] == 200
    finally:
        server.shutdown()
        server.server_close()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["events.jsonl"]


def test_launcher_only_starts_workers_for_paper_runs(tmp_path):
    assert worker_blocker(tmp_path / "fresh") is None
    assert "never starts live" in worker_blocker(tmp_path / "live")

    live = tmp_path / "custom"
    live.mkdir()
    wal_ledger(live / "ledger.sqlite", mode="live").close()
    assert "ledger mode: live" in worker_blocker(live)

    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / "ledger.sqlite").write_bytes(b"not a database")
    assert "unreadable" in worker_blocker(broken)

    paper = tmp_path / "paper"
    paper.mkdir()
    wal_ledger(paper / "ledger.sqlite", mode="paper", halted=None).close()
    assert worker_blocker(paper) is None
    (paper / "STOP").touch()
    assert "STOP exists" in worker_blocker(paper)
    (paper / "STOP").unlink()
    wal_ledger(tmp_path / "halted.sqlite", mode="paper", halted="Loss stop").close()
    (tmp_path / "halted.sqlite").replace(paper / "ledger.sqlite")
    assert "halted (Loss stop)" in worker_blocker(paper)


def test_worker_output_is_relayed_after_exit(tmp_path, capsys):
    log = tmp_path / "worker.log"
    with log.open("wb") as out:
        proc = subprocess.Popen(
            [sys.executable, "-c", "print('{\"tick\": 1}'); print('A worker already owns this run directory')"],
            stdout=out,
        )
    follow(proc, log.open("rb"))
    lines = capsys.readouterr().out.splitlines()
    assert lines == [
        '[fly] {"tick": 1}',
        "[fly] a worker is already running for this run directory; the viewer will follow it",
    ]
