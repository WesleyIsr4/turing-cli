import {
  acpCommands,
  acpSessionPool,
  configToAcpMcpServers,
  createOpencodePermissionResolver,
  EventAdapter,
  translate,
  type AISdkStreamPart,
  type OpencodePermissionAsk,
  type PoolEntry,
} from "@/acp-client"
import { buildMemoryContextBlock, openStoreForWorkspace } from "@/memory"
import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk"
import { Log } from "@/util"
import type { ModelMessage } from "ai"

const log = Log.create({ service: "llm.claude-code" })

export interface StreamClaudeCodeInput {
  sessionID: string
  messages: ModelMessage[]
  config: unknown
  cwd: string
  abort: AbortSignal
  /**
   * Claude Code variant chosen by the user (default/sonnet/haiku/etc).
   * If different from the current ACP session's model, we issue a
   * `session/set_model` before sending the prompt.
   */
  modelID?: string
  /**
   * turing agent name for this turn (e.g. "build", "plan"). When mappable
   * to an ACP mode (plan→plan, build→default) we issue `session/set_mode`
   * so Claude Code's agent-side behavior matches turing's permission layer.
   */
  agentName?: string
  /** If provided, routes ACP requestPermission through turing's permission system. */
  permission?: OpencodePermissionAsk
  /** If provided, invoked each time the ACP agent publishes a plan update. */
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>
}

/**
 * Maps an turing agent name to the corresponding Claude Code ACP mode id.
 * Returns undefined for agents that don't map (subagents, custom agents) —
 * the caller should skip setMode in that case.
 */
export function agentNameToAcpMode(agentName: string | undefined): string | undefined {
  if (!agentName) return undefined
  switch (agentName) {
    case "plan":
      return "plan"
    case "build":
      return "default"
    default:
      return undefined
  }
}

export interface PlanEntry {
  content: string
  status: "pending" | "in_progress" | "completed"
  priority: "high" | "medium" | "low"
}

/**
 * Implements the Claude Code bypass for LLM.Service. Reuses a pooled
 * ACP subprocess+session keyed by turing sessionID so successive turns
 * skip cold start and retain Claude Code's in-memory context.
 *
 * Yields AI SDK TextStreamPart events compatible with turing's session
 * processor.
 */
export async function* streamClaudeCode(
  input: StreamClaudeCodeInput,
): AsyncGenerator<AISdkStreamPart> {
  const adapter = new EventAdapter()
  const pendingQueue: AISdkStreamPart[] = []

  const resolvePermission = input.permission
    ? createOpencodePermissionResolver(input.permission)
    : undefined

  const onAcpUpdate = (notif: Parameters<typeof translate>[0]) => {
    for (const ev of translate(notif)) {
      if (ev.kind === "commands") {
        acpCommands.set(input.sessionID, ev.commands)
      } else if (ev.kind === "plan" && input.onPlan) {
        void input.onPlan(
          (ev.entries as unknown as PlanEntry[]).map((e) => ({
            content: e.content,
            status: e.status,
            priority: e.priority,
          })),
        )
      } else if (ev.kind === "mode") {
        const pooled = acpSessionPool.getEntry("claude-code", input.sessionID)
        if (pooled) pooled.currentModeId = ev.modeId
      }
      for (const part of adapter.next(ev)) pendingQueue.push(part)
    }
  }

  const memorySnapshot = buildMemoryContextBlock(openStoreForWorkspace(input.cwd).snapshot())

  const acquire = await acpSessionPool.acquire({
    agentId: "claude-code",
    turingSessionId: input.sessionID,
    cwd: input.cwd,
    mcpServers: configToAcpMcpServers(input.config as any),
    onSessionUpdate: onAcpUpdate,
    resolvePermission,
    memorySnapshot,
  })

  if (!acquire.ok) {
    yield { type: "start" }
    yield {
      type: "error",
      error: new Error(acquire.message ?? "claude CLI not authenticated"),
    }
    return
  }

  const entry: PoolEntry = acquire.entry
  // Rebind handlers to this turn's adapter (in case entry was reused).
  acpSessionPool.bindHandlers(entry, onAcpUpdate, resolvePermission)

  const cancelAcp = () => {
    void entry.connection
      .cancel(entry.acpSessionId)
      .catch((e) => log.debug("acp cancel error", { error: String(e) }))
  }
  input.abort.addEventListener("abort", cancelAcp, { once: true })

  try {
    for (const part of adapter.start()) yield part

    if (input.modelID && input.modelID !== entry.currentModelId) {
      log.info("switching ACP model", { from: entry.currentModelId, to: input.modelID })
      try {
        await acpSessionPool.setModel("claude-code", input.sessionID, input.modelID)
      } catch (err) {
        log.warn("failed to switch ACP model", { error: String(err) })
      }
    }

    const targetMode = agentNameToAcpMode(input.agentName)
    if (targetMode && targetMode !== entry.currentModeId) {
      log.info("switching ACP mode", {
        agent: input.agentName,
        from: entry.currentModeId,
        to: targetMode,
      })
      try {
        await acpSessionPool.setMode("claude-code", input.sessionID, targetMode)
      } catch (err) {
        log.warn("failed to switch ACP mode", { error: String(err) })
      }
    }

    const promptContent = extractAcpPromptContent(input.messages)
    if (!entry.memorySnapshotConsumed && entry.memorySnapshot) {
      promptContent.unshift({ type: "text", text: entry.memorySnapshot })
      entry.memorySnapshotConsumed = true
    }

    const prompt = entry.connection.prompt(entry.acpSessionId, promptContent)

    for await (const _ of prompt.updates()) {
      while (pendingQueue.length) yield pendingQueue.shift()!
      if (input.abort.aborted) {
        for (const part of adapter.abort(input.abort.reason ? String(input.abort.reason) : undefined))
          yield part
        return
      }
    }
    while (pendingQueue.length) yield pendingQueue.shift()!

    const result = await prompt.result
    const reason = acpStopReasonToFinishReason(result.stopReason)
    const usage = extractUsage(result as unknown as Record<string, unknown>)
    for (const part of adapter.finish({
      finishReason: reason,
      rawFinishReason: result.stopReason,
      usage,
    }))
      yield part
  } catch (err) {
    log.error("streamClaudeCode failed", { error: String(err) })
    for (const part of adapter.error(err)) yield part
  } finally {
    input.abort.removeEventListener("abort", cancelAcp)
    // NOTE: we intentionally do NOT close the pool entry here — it stays warm
    // for the next turn. Entry is evicted on subprocess exit or explicit
    // acpSessionPool.release(..., sessionID) when the turing session ends.
  }
}

function extractAcpPromptContent(messages: ModelMessage[]): ContentBlock[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "user") continue
    return userContentToContentBlocks(m.content)
  }
  return [{ type: "text", text: "" }]
}

type UserContent = ModelMessage extends { content: infer C } ? C : unknown

function userContentToContentBlocks(content: UserContent): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }]

  const out: ContentBlock[] = []
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text })
    } else if (part.type === "image") {
      const data = typeof part.image === "string" ? part.image : ""
      const mimeType = (part.mediaType as string) ?? (part.mimeType as string) ?? "image/png"
      if (data) out.push({ type: "image", data, mimeType })
    } else if (part.type === "file") {
      const text = typeof part.data === "string" ? part.data : JSON.stringify(part.data ?? "")
      out.push({ type: "text", text })
    }
  }
  if (out.length === 0) out.push({ type: "text", text: "" })
  return out
}

function extractUsage(result: Record<string, unknown>):
  | {
      inputTokens: number
      outputTokens: number
      totalTokens: number
      cachedReadTokens?: number
      cachedWriteTokens?: number
    }
  | undefined {
  const usage = result.usage as Record<string, unknown> | undefined
  if (!usage) return undefined
  const input = Number(usage.inputTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0)
  const total = Number(usage.totalTokens ?? input + output)
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedReadTokens: typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : undefined,
    cachedWriteTokens: typeof usage.cachedWriteTokens === "number" ? usage.cachedWriteTokens : undefined,
  }
}

function acpStopReasonToFinishReason(
  reason: StopReason | undefined,
):
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other"
  | "unknown" {
  if (!reason) return "unknown"
  switch (reason) {
    case "end_turn":
      return "stop"
    case "max_tokens":
      return "length"
    case "max_turn_requests":
      return "length"
    case "refusal":
      return "content-filter"
    case "cancelled":
      return "other"
    default:
      return "unknown"
  }
}
