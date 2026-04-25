import { describe, expect, test } from "bun:test"
import { spawnACPAgent } from "@/acp-client/subprocess"
import { ACPConnection } from "@/acp-client/connection"
import { createClientHandler } from "@/acp-client/handler"
import type { SessionNotification } from "@agentclientprotocol/sdk"

describe("ACP connection E2E", () => {
  test("initialize, newSession, prompt with streaming updates", async () => {
    const proc = spawnACPAgent({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      cwd: "/tmp",
    })

    const collected: SessionNotification[] = []
    const conn = new ACPConnection({
      process: proc,
      clientHandler: createClientHandler({
        onSessionUpdate(params) {
          collected.push(params)
        },
      }),
    })

    try {
      const init = await conn.initialize()
      expect(init.protocolVersion).toBe(1)

      const session = await conn.newSession({ cwd: "/tmp" })
      expect(session.sessionId).toBeTruthy()

      const prompt = conn.prompt(session.sessionId, [
        { type: "text", text: "Say hi in exactly 5 words. No tools." },
      ])

      const updatesFromStream: SessionNotification[] = []
      for await (const u of prompt.updates()) {
        updatesFromStream.push(u)
      }

      const result = await prompt.result
      expect(result.stopReason).toBeDefined()
      expect(updatesFromStream.length).toBeGreaterThan(0)
      expect(collected.length).toBeGreaterThanOrEqual(updatesFromStream.length)

      const textChunks = updatesFromStream.filter(
        (u) => u.update.sessionUpdate === "agent_message_chunk",
      )
      expect(textChunks.length).toBeGreaterThan(0)
    } finally {
      await conn.close()
    }
  }, 120000)
})
