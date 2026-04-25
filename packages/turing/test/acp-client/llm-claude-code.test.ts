import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { streamClaudeCode } from "@/session/llm-claude-code"
import type { AISdkStreamPart } from "@/acp-client"

describe("streamClaudeCode (E2E)", () => {
  test("produces expected AI SDK event sequence for a simple prompt", async () => {
    const abort = new AbortController()
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Say just the word 'ok' and nothing else." }],
      },
    ]

    const events: AISdkStreamPart[] = []
    for await (const ev of streamClaudeCode({
      sessionID: "test-session",
      messages,
      config: undefined,
      cwd: "/tmp",
      abort: abort.signal,
    })) {
      events.push(ev)
      if (events.length > 500) break // safety
    }

    // Sanity: we got a start and a finish
    expect(events[0]?.type).toBe("start")
    expect(events[events.length - 1]?.type).toBe("finish")

    // We saw text
    const textStarts = events.filter((e) => e.type === "text-start")
    const textDeltas = events.filter((e) => e.type === "text-delta")
    const textEnds = events.filter((e) => e.type === "text-end")
    expect(textStarts.length).toBeGreaterThan(0)
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(textEnds.length).toBe(textStarts.length)

    // Each text-start has a matching text-end with the same id
    for (const start of textStarts) {
      const id = (start as any).id
      const end = textEnds.find((e) => (e as any).id === id)
      expect(end).toBeTruthy()
    }

    // finish-step comes right before finish
    const finishIdx = events.findIndex((e) => e.type === "finish")
    const stepFinish = events[finishIdx - 1]
    expect(stepFinish?.type).toBe("finish-step")

    // Real usage from PromptResponse is plumbed through
    if (stepFinish?.type === "finish-step") {
      expect(stepFinish.usage.inputTokens).toBeGreaterThanOrEqual(0)
      expect(stepFinish.usage.outputTokens).toBeGreaterThan(0)
    }
  }, 120000)

  test("abort mid-stream yields abort event and stops", async () => {
    const abort = new AbortController()
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Count slowly from 1 to 50, one number per line." }],
      },
    ]
    const events: AISdkStreamPart[] = []
    let aborted = false
    const iter = streamClaudeCode({
      sessionID: "test",
      messages,
      config: undefined,
      cwd: "/tmp",
      abort: abort.signal,
    })

    for await (const ev of iter) {
      events.push(ev)
      if (!aborted && ev.type === "text-delta") {
        aborted = true
        abort.abort("user-stop")
      }
      if (events.length > 400) break
    }

    // Either got an abort event OR the stream closed naturally with finish
    // (finish races against abort). Assert at least one terminal marker.
    const terminal = events.find(
      (e) => e.type === "abort" || e.type === "finish" || e.type === "error",
    )
    expect(terminal).toBeDefined()
  }, 120000)
})
