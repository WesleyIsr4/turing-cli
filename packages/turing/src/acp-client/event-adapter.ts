import type { TranslatedEvent, TranslatedToolContent } from "./translator"

/**
 * AI SDK v6 `TextStreamPart` subset emitted by the adapter. Type locally
 * rather than imported to decouple from AI SDK re-exports; processor.ts
 * consumes these field names directly.
 */
export type AISdkStreamPart =
  | { type: "start" }
  | { type: "start-step"; request: Record<string, unknown>; warnings: [] }
  | { type: "text-start"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-start"
      id: string
      toolName: string
      title?: string
      providerMetadata?: Record<string, unknown>
    }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
      providerMetadata?: Record<string, unknown>
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      output: unknown
      providerMetadata?: Record<string, unknown>
    }
  | {
      type: "tool-error"
      toolCallId: string
      toolName: string
      error: string
      providerMetadata?: Record<string, unknown>
    }
  | {
      type: "finish-step"
      response: Record<string, unknown>
      usage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
        reasoningTokens?: number
        cachedInputTokens?: number
      }
      finishReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other" | "unknown"
      rawFinishReason: string | undefined
      providerMetadata: Record<string, unknown> | undefined
    }
  | {
      type: "finish"
      finishReason: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other" | "unknown"
      rawFinishReason: string | undefined
      totalUsage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
        reasoningTokens?: number
        cachedInputTokens?: number
      }
    }
  | { type: "error"; error: unknown }
  | { type: "abort"; reason?: string }

export interface EventAdapterOptions {
  /**
   * Create an AI-SDK-shaped usage payload from the last-seen ACP UsageUpdate.
   * If omitted, a zero-filled usage is produced — callers typically want to
   * supply real numbers from elsewhere (e.g. claude's own usage tracking).
   */
  usageProvider?: () => {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    reasoningTokens?: number
    cachedInputTokens?: number
  }
}

type TextState = { id: string; open: boolean }
type ReasoningState = { id: string; open: boolean }
type ToolState = { toolName: string; emittedCall: boolean }

/**
 * Stateful adapter that converts a stream of ACP `TranslatedEvent`s into
 * AI SDK `TextStreamPart`s that turing's session processor consumes.
 *
 * The adapter owns the synthetic IDs for text parts / reasoning parts so
 * that open/close pairs stay balanced (turing's processor.ts relies on
 * text-start → text-delta* → text-end ordering).
 */
export class EventAdapter {
  #options: EventAdapterOptions
  #text: TextState | null = null
  #reasoning: ReasoningState | null = null
  #tools = new Map<string, ToolState>()
  #seq = 0
  #usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  #lastAcpUsage: { used: number; size: number } | null = null
  #started = false

  constructor(options: EventAdapterOptions = {}) {
    this.#options = options
  }

  /** Emit AI SDK "start" + "start-step" exactly once before any other events. */
  start(): AISdkStreamPart[] {
    if (this.#started) return []
    this.#started = true
    return [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
    ]
  }

  /** Process one ACP event; returns 0..N AI SDK events to emit. */
  next(event: TranslatedEvent): AISdkStreamPart[] {
    const out: AISdkStreamPart[] = []
    switch (event.kind) {
      case "text": {
        // Close any open reasoning first; text and reasoning are sibling parts.
        if (this.#reasoning?.open) {
          out.push({ type: "reasoning-end", id: this.#reasoning.id })
          this.#reasoning.open = false
        }
        if (!this.#text) {
          const id = this.#id("text")
          this.#text = { id, open: true }
          out.push({ type: "text-start", id })
        }
        out.push({ type: "text-delta", id: this.#text.id, text: event.text })
        return out
      }

      case "thought": {
        if (this.#text?.open) {
          out.push({ type: "text-end", id: this.#text.id })
          this.#text.open = false
        }
        if (!this.#reasoning) {
          const id = this.#id("reasoning")
          this.#reasoning = { id, open: true }
          out.push({ type: "reasoning-start", id })
        }
        out.push({ type: "reasoning-delta", id: this.#reasoning.id, text: event.text })
        return out
      }

      case "tool-start": {
        // Starting a tool means prior text/reasoning parts are done.
        out.push(...this.#closeOpenParts())

        this.#tools.set(event.callId, {
          toolName: event.toolName,
          emittedCall: false,
        })

        out.push({
          type: "tool-input-start",
          id: event.callId,
          toolName: event.toolName,
          title: event.title,
        })

        // ACP ships tool calls with full input upfront; emit tool-call immediately.
        out.push({
          type: "tool-call",
          toolCallId: event.callId,
          toolName: event.toolName,
          input: event.input,
        })
        this.#tools.get(event.callId)!.emittedCall = true

        // If the tool-start already has final status (completed/failed), emit result too.
        if (event.status === "completed") {
          out.push(toolResultFromContent(event.callId, event.toolName, event.content))
        } else if (event.status === "failed") {
          out.push({
            type: "tool-error",
            toolCallId: event.callId,
            toolName: event.toolName,
            error: toolErrorText(event.content) ?? "Tool failed",
          })
        }
        return out
      }

      case "tool-update": {
        const state = this.#tools.get(event.callId)
        const toolName = state?.toolName ?? event.toolName ?? "tool"

        // If we never emitted tool-call (shouldn't happen for ACP, but guard),
        // synthesize tool-input-start + tool-call now.
        if (state && !state.emittedCall) {
          out.push({ type: "tool-input-start", id: event.callId, toolName, title: event.title })
          out.push({
            type: "tool-call",
            toolCallId: event.callId,
            toolName,
            input: event.input ?? {},
          })
          state.emittedCall = true
        }

        if (event.status === "completed") {
          out.push(toolResultFromContent(event.callId, toolName, event.content, event.rawOutput))
        } else if (event.status === "failed") {
          out.push({
            type: "tool-error",
            toolCallId: event.callId,
            toolName,
            error: toolErrorText(event.content) ?? "Tool failed",
          })
        }
        return out
      }

      case "usage": {
        this.#lastAcpUsage = { used: event.used, size: event.size }
        // Rough heuristic: turing wants input/output token split. ACP's
        // "used" is cumulative context size; treat as input+output sum.
        // Consumers that care about the split should use a custom usageProvider.
        this.#usage = {
          inputTokens: event.used,
          outputTokens: 0,
          totalTokens: event.used,
        }
        return []
      }

      case "plan":
      case "commands":
      case "mode":
      case "session-info":
      case "unknown":
        return []
    }
    return out
  }

  /** Emit terminal events (close open parts, step-finish, finish). */
  finish(args: {
    finishReason?:
      | "stop"
      | "length"
      | "tool-calls"
      | "content-filter"
      | "error"
      | "other"
      | "unknown"
    rawFinishReason?: string | undefined
    providerMetadata?: Record<string, unknown>
    /**
     * Preferred over internal estimates. Should be sourced from the agent's
     * final PromptResponse.usage for accurate billing/context display.
     */
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      cachedReadTokens?: number | null
      cachedWriteTokens?: number | null
      reasoningTokens?: number
    }
  }): AISdkStreamPart[] {
    const out: AISdkStreamPart[] = []
    out.push(...this.#closeOpenParts())

    const reason = args.finishReason ?? "stop"
    const usage = this.#resolveUsage(args.usage)

    out.push({
      type: "finish-step",
      response: {},
      usage,
      finishReason: reason,
      rawFinishReason: args.rawFinishReason,
      providerMetadata: args.providerMetadata,
    })
    out.push({
      type: "finish",
      finishReason: reason,
      rawFinishReason: args.rawFinishReason,
      totalUsage: usage,
    })
    return out
  }

  #resolveUsage(explicit?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedReadTokens?: number | null
    cachedWriteTokens?: number | null
    reasoningTokens?: number
  }) {
    if (explicit) {
      const input = explicit.inputTokens ?? 0
      const output = explicit.outputTokens ?? 0
      const total = explicit.totalTokens ?? input + output
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        reasoningTokens: explicit.reasoningTokens,
        cachedInputTokens: explicit.cachedReadTokens ?? undefined,
      }
    }
    if (this.#options.usageProvider) return this.#options.usageProvider()
    return this.#usage
  }

  /** Emit an error event. */
  error(err: unknown): AISdkStreamPart[] {
    return [...this.#closeOpenParts(), { type: "error", error: err }]
  }

  /** Emit an abort event and close any open parts. */
  abort(reason?: string): AISdkStreamPart[] {
    return [...this.#closeOpenParts(), { type: "abort", reason }]
  }

  #closeOpenParts(): AISdkStreamPart[] {
    const out: AISdkStreamPart[] = []
    if (this.#text?.open) {
      out.push({ type: "text-end", id: this.#text.id })
      this.#text.open = false
    }
    if (this.#reasoning?.open) {
      out.push({ type: "reasoning-end", id: this.#reasoning.id })
      this.#reasoning.open = false
    }
    return out
  }

  #id(prefix: string): string {
    this.#seq++
    return `${prefix}_${this.#seq}`
  }
}

function toolResultFromContent(
  toolCallId: string,
  toolName: string,
  content: TranslatedToolContent[],
  rawOutput?: unknown,
): AISdkStreamPart {
  if (rawOutput !== undefined && rawOutput !== null) {
    return { type: "tool-result", toolCallId, toolName, output: rawOutput }
  }
  const output = content
    .map((c) => {
      if (c.type === "text") return c.text
      if (c.type === "diff") return `${c.path}\n${c.newText}`
      if (c.type === "resource-link") return c.uri
      return JSON.stringify(c)
    })
    .join("\n")
    .trim()
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output: output || "",
  }
}

function toolErrorText(content: TranslatedToolContent[]): string | undefined {
  for (const c of content) {
    if (c.type === "text" && c.text.trim()) return c.text
  }
  return undefined
}
