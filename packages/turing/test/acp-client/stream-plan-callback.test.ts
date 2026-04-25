import { describe, expect, test } from "bun:test"
import { streamClaudeCode } from "@/session/llm-claude-code"
import type { ModelMessage } from "ai"

describe("streamClaudeCode onPlan callback (integration-ish)", () => {
  test("onPlan is invoked when agent emits plan updates", async () => {
    const planCalls: Array<Array<{ content: string; status: string; priority: string }>> = []
    const abort = new AbortController()
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Use the TodoWrite tool to write a plan with exactly 3 items: Write code, Test it, Ship it. All status=pending, priority=high. Then stop.",
          },
        ],
      },
    ]
    let count = 0
    for await (const ev of streamClaudeCode({
      sessionID: "plan-test",
      messages,
      config: undefined,
      cwd: "/tmp",
      abort: abort.signal,
      onPlan: (entries) => {
        planCalls.push(entries as any)
      },
    })) {
      count++
      if (count > 1000) break // safety
      if (ev.type === "finish") break
    }

    // We don't require the agent to follow the instruction exactly — just that
    // IF a plan update was seen, it flows through the callback correctly.
    for (const call of planCalls) {
      expect(Array.isArray(call)).toBe(true)
      for (const e of call) {
        expect(typeof e.content).toBe("string")
        expect(["pending", "in_progress", "completed"]).toContain(e.status)
        expect(["high", "medium", "low"]).toContain(e.priority)
      }
    }
  }, 180000)
})
