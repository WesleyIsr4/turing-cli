# ACP Fixtures

Real payloads captured from `@agentclientprotocol/claude-agent-acp@0.30.0` running on a machine with authenticated `claude` CLI. Used for translator and connection tests.

## Files

| File | Type | Notes |
|---|---|---|
| `01-initialize-response.json` | response to `initialize` | protocolVersion 1, full capability set |
| `02-session-new-response.json` | response to `session/new` | contains models + modes + configOptions advertised by Claude Code |
| `03-notif-available-commands-update.json` | `session/update` notif | **truncated** — originally had 500+ skill commands from local env |
| `04-notif-usage-update.json` | `session/update` notif | token counters |
| `05-notif-agent-message-chunk.json` | `session/update` notif | streaming text from assistant |
| `06-notif-tool-call.json` | `session/update` notif | tool call announced (Bash tool, status `pending`) |
| `06-notif-tool-call-update.json` | `session/update` notif | tool call completion (stdout/stderr returned) |
| `99-prompt-final-response.json` | response to `session/prompt` | final stop reason |

## How these were captured

```bash
# 1. Simple prompt (no tools)
bun run /tmp/acp-capture.ts

# 2. Tool-using prompt
bun run /tmp/acp-capture-tools.ts
```

Both scripts spawn `npx @agentclientprotocol/claude-agent-acp`, send `initialize` + `session/new` + `session/prompt`, and log every NDJSON message.

## Regenerating

Run the scripts again after updating `claude-agent-acp`:
```bash
npm view @agentclientprotocol/claude-agent-acp version
```
