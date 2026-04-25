import { describe, expect, test } from "bun:test"
import { streamClaudeCode } from "@/session/llm-claude-code"
import { acpSessionPool } from "@/acp-client"
import type { ModelMessage } from "ai"

describe("streamClaudeCode auto model switch", () => {
  test("changes ACP currentModelId when input.modelID differs from pooled current", async () => {
    const abort = new AbortController()
    const sessionID = "auto-switch-test"
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Say 'ok' in exactly 2 words." }] },
    ]

    // First turn with haiku — spawns a fresh pool entry and the first
    // setModel call should flip currentModelId to 'haiku'.
    const events: string[] = []
    for await (const ev of streamClaudeCode({
      sessionID,
      messages,
      config: undefined,
      cwd: "/tmp",
      abort: abort.signal,
      modelID: "haiku",
    })) {
      events.push(ev.type)
      if (ev.type === "finish") break
    }

    const entry = acpSessionPool.getEntry("claude-code", sessionID)
    expect(entry).toBeDefined()
    expect(entry!.currentModelId).toBe("haiku")

    await acpSessionPool.release("claude-code", sessionID)
  }, 180000)
})
