import type { McpServer } from "@agentclientprotocol/sdk"
import type { Config as OpencodeConfig } from "@turing-ai/sdk"

/**
 * Opencode's config supports an `mcp` record with entries shaped per server
 * (local stdio, remote http/sse). We translate those to ACP `McpServer`s so
 * they can be injected into `session/new` when spawning claude-agent-acp.
 *
 * Claude Code also reads its own config from `~/.claude.json` — servers
 * configured there keep working. What we inject here is ADDITIONAL to that.
 */
export function configToAcpMcpServers(cfg: OpencodeConfig | undefined): McpServer[] {
  const entries = (cfg?.mcp ?? {}) as Record<string, unknown>
  const out: McpServer[] = []

  for (const [name, raw] of Object.entries(entries)) {
    const server = toAcpMcp(name, raw)
    if (server) out.push(server)
  }
  return out
}

function toAcpMcp(name: string, raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null
  const v = raw as Record<string, unknown>

  // turing supports `type: "local" | "remote"` or shape-inferred
  if (v.type === "remote" || v.url) {
    const url = String(v.url ?? "")
    if (!url) return null
    const headers = objectHeadersToArray((v.headers ?? {}) as Record<string, string>)
    // Default to http; use sse only if explicitly indicated
    if (v.transport === "sse") {
      return { type: "sse", name, url, headers }
    }
    return { type: "http", name, url, headers }
  }

  const command = v.command
  if (typeof command !== "string" || !command) return null

  const args = Array.isArray(v.args) ? (v.args as string[]) : []
  const envRecord = (v.environment ?? v.env ?? {}) as Record<string, string>
  const env = Object.entries(envRecord).map(([k, value]) => ({ name: k, value: String(value) }))

  return {
    name,
    command,
    args,
    env,
  }
}

function objectHeadersToArray(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
}
