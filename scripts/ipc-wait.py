#!/usr/bin/env python3
"""Event-driven IPC bridge: block until a new message arrives for an instance.

The claude-ipc broker persists to ~/.claude-ipc-data/messages.db but pushes to
nobody — agents must poll. This watcher polls the SQLite store cheaply and exits
the moment an unread message addressed to `me` appears, so the Claude Code harness
re-invokes the agent on a real event instead of a fixed timer.

Usage: ipc-wait.py <me> [timeout_seconds]
Exit 0 = message waiting (caller should run the MCP `check` tool).
Exit 2 = timed out with no message.
"""
import os, sys, time, sqlite3

me = sys.argv[1] if len(sys.argv) > 1 else "claude"
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 1800
db = os.path.expanduser("~/.claude-ipc-data/messages.db")

deadline = time.time() + timeout
while time.time() < deadline:
    try:
        c = sqlite3.connect(db)
        row = c.execute(
            "SELECT id, from_id FROM messages WHERE to_id=? AND read_flag=0 "
            "ORDER BY id DESC LIMIT 1", (me,)
        ).fetchone()
        c.close()
        if row:
            print(f"MESSAGE id={row[0]} from={row[1]}")
            sys.exit(0)
    except sqlite3.Error as e:
        print(f"db error: {e}", file=sys.stderr)
    time.sleep(3)

print("timeout")
sys.exit(2)
