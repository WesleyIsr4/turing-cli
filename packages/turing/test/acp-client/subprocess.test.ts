import { describe, expect, test } from "bun:test"
import { spawnACPAgent } from "@/acp-client/subprocess"
import { ndJsonStream } from "@agentclientprotocol/sdk"

describe("ACP subprocess manager", () => {
  test("spawn, initialize handshake, shutdown cleanly", async () => {
    const proc = spawnACPAgent({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      cwd: "/tmp",
    })
    expect(proc.pid).toBeGreaterThan(0)

    const stream = ndJsonStream(proc.stdin, proc.stdout)
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()

    const initMsg = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      },
    }
    await writer.write(initMsg as any)

    const { value: response } = await reader.read()
    expect(response).toBeDefined()
    const resp = response as any
    expect(resp.id).toBe(1)
    expect(resp.result?.protocolVersion).toBe(1)
    expect(resp.result?.agentInfo?.name).toBe("@agentclientprotocol/claude-agent-acp")

    await proc.shutdown()
    const code = await proc.exited
    // 0 = clean, 143 = SIGTERM (128+15), 137 = SIGKILL (128+9), null = unknown
    expect([0, 143, 137, null]).toContain(code)
  }, 60000)
})
