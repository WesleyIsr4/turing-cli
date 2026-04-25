import { describe, expect, test } from "bun:test"
import { agentNameToAcpMode, streamClaudeCode } from "@/session/llm-claude-code"
import { acpSessionPool } from "@/acp-client"
import type { ModelMessage } from "ai"

describe("agentNameToAcpMode", () => {
  test("maps turing primary agents to ACP mode ids", () => {
    expect(agentNameToAcpMode("plan")).toBe("plan")
    expect(agentNameToAcpMode("build")).toBe("default")
  })

  test("returns undefined for unknown/undefined agents (no-op signal)", () => {
    expect(agentNameToAcpMode(undefined)).toBeUndefined()
    expect(agentNameToAcpMode("general")).toBeUndefined()
    expect(agentNameToAcpMode("explore")).toBeUndefined()
    expect(agentNameToAcpMode("custom-agent")).toBeUndefined()
  })
})

describe("streamClaudeCode auto mode switch", () => {
  test("sets ACP currentModeId based on input.agentName on first turn", async () => {
    const abort = new AbortController()
    const sessionID = "auto-switch-mode-test"
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Say 'ok' in exactly 2 words." }] },
    ]

    const events: string[] = []
    for await (const ev of streamClaudeCode({
      sessionID,
      messages,
      config: undefined,
      cwd: "/tmp",
      abort: abort.signal,
      agentName: "plan",
    })) {
      events.push(ev.type)
      if (ev.type === "finish") break
    }

    const entry = acpSessionPool.getEntry("claude-code", sessionID)
    expect(entry).toBeDefined()
    expect(entry!.currentModeId).toBe("plan")

    await acpSessionPool.release("claude-code", sessionID)
  }, 180000)
})
