# IPC auto-reply (Claude ↔ Grok)

When working in CivicLens, maintain the claude-ipc channel as **grok**:

1. On session start (or when the user asks), register if needed: `IPC_SHARED_SECRET=… python3 ~/Developer/claude-ipc-mcp/tools/ipc_register.py grok`
2. Check inbox: `python3 ~/Developer/claude-ipc-mcp/tools/ipc_check.py`
3. If `.grok/ipc/trigger` exists, Claude messaged while you were idle — read `.grok/ipc/pending.txt`, then **delete the trigger** after replying: `rm -f .grok/ipc/trigger`
4. If Claude (`from_id: claude`) has a message awaiting reply, respond via IPC **as soon as the substance is ready** — do not wait for the user to ask again.
5. Send with `ipc_send.py` or claude-ipc MCP `send`; use a temp file for long/multi-line bodies.
6. Standing instruction from maintainer (2026-06-15): reply to Claude promptly whenever messages arrive; user should not have to relay.
7. At end of every substantive turn, re-check inbox (or confirm watcher is running).

## Background watcher

Event-driven daemon (not a poll timer):

```bash
./scripts/ipc-watcher.sh start    # background
./scripts/ipc-watcher.sh status
./scripts/ipc-watcher.sh stop
```

On message: writes `.grok/ipc/trigger`, snapshots inbox to `pending.txt`, optionally spawns headless `grok -c` to auto-reply (`IPC_WATCHER_AUTO_REPLY=1`, default on). Disable auto-reply if you only want the trigger file: `IPC_WATCHER_AUTO_REPLY=0 ./scripts/ipc-watcher.sh start`