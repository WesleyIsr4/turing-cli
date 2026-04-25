import { describe, expect, test } from "bun:test"
import { EventAdapter } from "@/acp-client/event-adapter"
import type { TranslatedEvent } from "@/acp-client/translator"

describe("EventAdapter — text streaming", () => {
  test("emits text-start on first delta, then deltas, then text-end on finish", () => {
    const a = new EventAdapter()
    const start = a.start()
    expect(start.map((e) => e.type)).toEqual(["start", "start-step"])

    const first = a.next(evText("Hello"))
    expect(first.map((e) => e.type)).toEqual(["text-start", "text-delta"])
    const firstStart = first[0] as any
    const firstDelta = first[1] as any
    expect(firstStart.id).toBe(firstDelta.id)
    expect(firstDelta.text).toBe("Hello")

    const more = a.next(evText(" world"))
    expect(more.map((e) => e.type)).toEqual(["text-delta"])
    expect((more[0] as any).text).toBe(" world")
    expect((more[0] as any).id).toBe(firstDelta.id)

    const done = a.finish({})
    expect(done.map((e) => e.type)).toEqual(["text-end", "finish-step", "finish"])
  })

  test("calling start() twice is a no-op", () => {
    const a = new EventAdapter()
    expect(a.start().length).toBe(2)
    expect(a.start().length).toBe(0)
  })
})

describe("EventAdapter — reasoning streaming", () => {
  test("maps thought to reasoning-start/delta", () => {
    const a = new EventAdapter()
    a.start()
    const events = a.next(evThought("thinking..."))
    expect(events.map((e) => e.type)).toEqual(["reasoning-start", "reasoning-delta"])
    const done = a.finish({})
    expect(done[0].type).toBe("reasoning-end")
  })

  test("switching from text to thought closes text first", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evText("typed"))
    const switched = a.next(evThought("pondered"))
    expect(switched.map((e) => e.type)).toEqual(["text-end", "reasoning-start", "reasoning-delta"])
  })

  test("switching from thought to text closes thought first", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evThought("musing"))
    const switched = a.next(evText("now typing"))
    expect(switched.map((e) => e.type)).toEqual(["reasoning-end", "text-start", "text-delta"])
  })
})

describe("EventAdapter — tools", () => {
  test("tool-start (pending) closes open parts, emits tool-input-start + tool-call", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evText("i will use a tool"))
    const events = a.next(evToolStart("c1", "bash", { command: "ls" }, "pending"))
    expect(events.map((e) => e.type)).toEqual(["text-end", "tool-input-start", "tool-call"])
    const call = events.find((e) => e.type === "tool-call") as any
    expect(call.toolCallId).toBe("c1")
    expect(call.toolName).toBe("bash")
    expect(call.input).toEqual({ command: "ls" })
  })

  test("tool-start with status:completed emits result in same batch", () => {
    const a = new EventAdapter()
    a.start()
    const events = a.next(
      evToolStart("c1", "bash", { command: "echo hi" }, "completed", [
        { type: "text", text: "hi\n" },
      ]),
    )
    const types = events.map((e) => e.type)
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-call")
    expect(types).toContain("tool-result")
    const result = events.find((e) => e.type === "tool-result") as any
    expect(result.toolCallId).toBe("c1")
  })

  test("tool-update with status:completed after tool-start emits only result", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evToolStart("c1", "bash", { command: "ls" }, "pending"))
    const update = a.next(evToolUpdate("c1", "bash", "completed", [{ type: "text", text: "ok" }]))
    expect(update.map((e) => e.type)).toEqual(["tool-result"])
  })

  test("tool-update with status:failed emits tool-error", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evToolStart("c1", "bash", { command: "fails" }, "pending"))
    const update = a.next(evToolUpdate("c1", "bash", "failed", [{ type: "text", text: "boom" }]))
    expect(update.map((e) => e.type)).toEqual(["tool-error"])
    expect((update[0] as any).error).toBe("boom")
  })

  test("tool-update when rawOutput is present prefers it over content", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evToolStart("c1", "bash", {}, "pending"))
    const raw = { ok: true, stdout: "x" }
    const update: TranslatedEvent = {
      kind: "tool-update",
      sessionId: "s",
      callId: "c1",
      toolName: "bash",
      title: undefined,
      status: "completed",
      input: undefined,
      rawInput: undefined,
      rawOutput: raw,
      content: [],
      locations: [],
    }
    const events = a.next(update)
    const result = events.find((e) => e.type === "tool-result") as any
    expect(result.output).toEqual(raw)
  })
})

describe("EventAdapter — usage + finish", () => {
  test("finish emits finish-step + finish with usage fallback from ACP usage_update", () => {
    const a = new EventAdapter()
    a.start()
    a.next({ kind: "usage", sessionId: "s", used: 1234, size: 200000 })
    const done = a.finish({ finishReason: "stop" })
    expect(done.map((e) => e.type)).toEqual(["finish-step", "finish"])
    const step = done[0] as any
    expect(step.usage.inputTokens).toBe(1234)
  })

  test("explicit usage from PromptResponse wins over ACP usage_update", () => {
    const a = new EventAdapter()
    a.start()
    a.next({ kind: "usage", sessionId: "s", used: 9999, size: 200000 })
    const done = a.finish({
      finishReason: "stop",
      usage: {
        inputTokens: 10,
        outputTokens: 50,
        totalTokens: 60,
        cachedReadTokens: 200,
        cachedWriteTokens: 50,
      },
    })
    const step = done[0] as any
    expect(step.usage.inputTokens).toBe(10)
    expect(step.usage.outputTokens).toBe(50)
    expect(step.usage.totalTokens).toBe(60)
    expect(step.usage.cachedInputTokens).toBe(200)
  })

  test("usageProvider override wins over ACP usage when no explicit usage", () => {
    const a = new EventAdapter({
      usageProvider: () => ({ inputTokens: 50, outputTokens: 10, totalTokens: 60 }),
    })
    a.start()
    a.next({ kind: "usage", sessionId: "s", used: 9999, size: 200000 })
    const done = a.finish({ finishReason: "stop" })
    const step = done[0] as any
    expect(step.usage.inputTokens).toBe(50)
    expect(step.usage.outputTokens).toBe(10)
  })
})

describe("EventAdapter — error + abort", () => {
  test("error closes open parts and emits error", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evText("partial"))
    const events = a.error(new Error("bang"))
    expect(events.map((e) => e.type)).toEqual(["text-end", "error"])
  })

  test("abort closes parts and emits abort", () => {
    const a = new EventAdapter()
    a.start()
    a.next(evText("partial"))
    const events = a.abort("user")
    expect(events.map((e) => e.type)).toEqual(["text-end", "abort"])
    expect((events[1] as any).reason).toBe("user")
  })
})

describe("EventAdapter — passthroughs", () => {
  test("plan/commands/mode/session-info/unknown emit nothing", () => {
    const a = new EventAdapter()
    a.start()
    expect(a.next({ kind: "plan", sessionId: "s", entries: [] as any })).toEqual([])
    expect(a.next({ kind: "commands", sessionId: "s", commands: [] })).toEqual([])
    expect(a.next({ kind: "mode", sessionId: "s", modeId: "default" })).toEqual([])
    expect(a.next({ kind: "session-info", sessionId: "s", meta: {} })).toEqual([])
    expect(a.next({ kind: "unknown", sessionId: "s", type: "x", raw: {} as any })).toEqual([])
  })
})

// ---- helpers ----
function evText(text: string): TranslatedEvent {
  return { kind: "text", sessionId: "s", text }
}
function evThought(text: string): TranslatedEvent {
  return { kind: "thought", sessionId: "s", text }
}
function evToolStart(
  callId: string,
  toolName: string,
  input: Record<string, unknown>,
  status: "pending" | "completed" | "failed",
  content: Array<{ type: "text"; text: string }> = [],
): TranslatedEvent {
  return {
    kind: "tool-start",
    sessionId: "s",
    callId,
    toolName,
    title: toolName,
    acpKind: undefined,
    input,
    rawInput: input,
    status: status === "failed" ? ("failed" as any) : (status as any),
    content,
    locations: [],
  }
}
function evToolUpdate(
  callId: string,
  toolName: string,
  status: "completed" | "failed",
  content: Array<{ type: "text"; text: string }> = [],
): TranslatedEvent {
  return {
    kind: "tool-update",
    sessionId: "s",
    callId,
    toolName,
    title: undefined,
    status: status as any,
    input: undefined,
    rawInput: undefined,
    rawOutput: undefined,
    content,
    locations: [],
  }
}
