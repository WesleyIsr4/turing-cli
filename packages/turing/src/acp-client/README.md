# ACP Client (Claude Code integration)

Consumes [Agent Client Protocol][acp] agents — specifically `claude-agent-acp` —
as subprocesses, letting turing treat Claude Code as a first-class model source.

This is the **client-side** counterpart to `src/acp/` (which is the server-side
implementation that exposes turing *to* ACP clients like Zed/JetBrains).

```
              src/acp/          ◀───── ACP ─────  Zed, JetBrains, Neovim
              (server)
              │
              ▼
          turing core
              ▲
              │
           src/acp-client/      ─────  ACP ────▶  claude-agent-acp (subprocess)
              (this folder)                            │
                                                       ▼
                                                @anthropic-ai/claude-agent-sdk
                                                       │
                                                       ▼
                                                   claude CLI
                                                (user auth via `claude auth login`)
```

## Modules

| File | Responsibility |
|---|---|
| `subprocess.ts` | Spawns agent binaries with Bun.spawn; exposes stdin as `WritableStream<Uint8Array>` |
| `connection.ts` | High-level `ACPConnection` wrapping `ClientSideConnection` |
| `handler.ts` | Implements the `Client` interface (sessionUpdate, permissions, fs ops) |
| `translator.ts` | Maps ACP `SessionNotification` events → turing-internal `TranslatedEvent`s |
| `event-adapter.ts` | Stateful adapter: `TranslatedEvent` → AI SDK `TextStreamPart` (subset). Owns text/reasoning IDs, tool call lifecycle. |
| `registry.ts` | Registry of known agent binaries (`claude-code`, future `codex-acp`, etc) |
| `auth.ts` | Runs the optional auth-check command (e.g. `claude auth status`) |
| `mcp-config.ts` | Translates turing's `mcp` config → ACP `McpServer[]` for injection |
| `session-pool.ts` | Singleton pool keyed by `(agentId, turingSessionId)` — keeps ACP subprocess+session warm across turns |
| `permission-bridge.ts` | Builds a `PermissionResolver` that routes ACP `requestPermission` through turing's `Permission.Service` |
| `commands-registry.ts` | Stores `available_commands_update` snapshots per turing session (for future UI/Command.Service integration) |
| `index.ts` | Public exports |

## Usage

```ts
import {
  spawnACPAgent,
  ACPConnection,
  createClientHandler,
  translate,
  getAgent,
  checkAgentAuth,
  configToAcpMcpServers,
} from "@/acp-client"

const agent = getAgent("claude-code")
const auth = await checkAgentAuth(agent)
if (!auth.ok) throw new Error(auth.message)

const proc = spawnACPAgent(agent)
const conn = new ACPConnection({
  process: proc,
  clientHandler: createClientHandler({
    onSessionUpdate(n) {
      for (const ev of translate(n)) {
        console.log(ev.kind, ev)
      }
    },
  }),
})

await conn.initialize()
const session = await conn.newSession({
  cwd: process.cwd(),
  mcpServers: configToAcpMcpServers(turingConfig),
})

const stream = conn.prompt(session.sessionId, [{ type: "text", text: "hi" }])
for await (const update of stream.updates()) {
  // Already dispatched via onSessionUpdate; iterate here if you want a
  // per-prompt view.
}
const result = await stream.result
console.log("stopReason:", result.stopReason)

await conn.close()
```

## Auth

Auth is delegated entirely to the `claude` CLI. Users must run `claude auth login`
once. The client never stores tokens, never performs OAuth, never inspects
`~/.claude/.credentials.json`. This is the only ToS-safe path as of April 2026.

## MCP configuration

Claude Code reads MCP servers from its own config (`~/.claude.json` /
project-level `.mcp.json`) automatically. Anything you add via turing's
`mcp` config is injected **additionally** via `session/new`. Both sources
coexist — turing-provided servers are session-scoped, Claude-Code-provided
servers are persistent across sessions.

## Known limitations

- Terminal capability not advertised; Claude Code's Bash tool still works
  because it runs inside the agent process.
- Permissions work when `session/llm.ts` passes the bridge; standalone
  callers get auto-allow unless they pass their own resolver.
- Slash commands from Claude Code are merged into `Command.Service`:
  `/commit`, `/review`, `/help`, etc. are invokable. Templates are
  `/name $ARGUMENTS` passthroughs — Claude Code's agent-side handler
  processes them.
- Mode/model switching is implemented at the pool level via
  `acpSessionPool.setMode()` / `setModel()`. TUI UI to expose these
  to end-users is a follow-up.
- Plans (Claude Code TodoWrite) flow into turing's `Todo.Service`
  via `streamClaudeCode({ onPlan })` callback.

## Testing

```bash
cd packages/turing
bun test test/acp-client
```

Fixtures in `test/acp-client/fixtures/` were captured from
`@agentclientprotocol/claude-agent-acp@0.30.0`. Regenerate with
`/tmp/acp-capture.ts` and `/tmp/acp-capture-tools.ts` (see
`test/acp-client/fixtures/README.md`).

[acp]: https://agentclientprotocol.com/
