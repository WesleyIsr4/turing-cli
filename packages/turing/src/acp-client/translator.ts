import type {
  AvailableCommand,
  ContentBlock,
  Cost,
  CurrentModeUpdate,
  PermissionOption,
  Plan,
  SessionNotification,
  ToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk"

/**
 * Events emitted by the translator after consuming a stream of ACP
 * `session/update` notifications. These are intentionally framework-agnostic
 * and mirror the information turing needs to render a session. The plugin
 * integration layer is responsible for turning these into SDK calls.
 */
export type TranslatedEvent =
  | {
      kind: "text"
      sessionId: string
      text: string
    }
  | {
      kind: "thought"
      sessionId: string
      text: string
    }
  | {
      kind: "tool-start"
      sessionId: string
      callId: string
      toolName: string
      title: string
      acpKind: ToolKind | undefined
      input: Record<string, unknown>
      rawInput: unknown
      status: ToolCallStatus | undefined
      content: Array<TranslatedToolContent>
      locations: Array<{ path: string; line: number | null | undefined }>
    }
  | {
      kind: "tool-update"
      sessionId: string
      callId: string
      toolName: string | undefined
      title: string | undefined
      status: ToolCallStatus | undefined
      input: Record<string, unknown> | undefined
      rawInput: unknown
      rawOutput: unknown
      content: Array<TranslatedToolContent>
      locations: Array<{ path: string; line: number | null | undefined }>
    }
  | {
      kind: "plan"
      sessionId: string
      entries: Plan["entries"]
    }
  | {
      kind: "commands"
      sessionId: string
      commands: Array<{
        name: string
        description: string
        hint?: string
      }>
    }
  | {
      kind: "mode"
      sessionId: string
      modeId: string
    }
  | {
      kind: "usage"
      sessionId: string
      used: number
      size: number
      cost?: Cost | null
    }
  | {
      kind: "permission-request"
      sessionId: string
      callId: string | undefined
      options: PermissionOption[]
    }
  | {
      kind: "session-info"
      sessionId: string
      meta: Record<string, unknown>
    }
  | {
      kind: "unknown"
      sessionId: string
      type: string
      raw: SessionNotification["update"]
    }

export type TranslatedToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "resource-link"; uri: string; name?: string; description?: string; mimeType?: string }
  | { type: "resource"; resource: unknown }
  | { type: "audio"; mimeType: string; data: string }
  | { type: "terminal"; terminalId: string }

/**
 * Translate an ACP session notification into 0..N turing-internal events.
 * Most notifications map 1:1; some (e.g. tool_call with multi-part content)
 * could in theory fan out, but we preserve the single-event shape to keep
 * ordering trivial.
 */
export function translate(notification: SessionNotification): TranslatedEvent[] {
  const sessionId = notification.sessionId
  const u = notification.update
  const type = u.sessionUpdate

  switch (type) {
    case "agent_message_chunk": {
      const text = contentToText(u.content)
      if (!text) return []
      return [{ kind: "text", sessionId, text }]
    }
    case "agent_thought_chunk": {
      const text = contentToText(u.content)
      if (!text) return []
      return [{ kind: "thought", sessionId, text }]
    }
    case "user_message_chunk":
      return []

    case "tool_call": {
      const call = u as ToolCall & { sessionUpdate: "tool_call" }
      return [
        {
          kind: "tool-start",
          sessionId,
          callId: call.toolCallId,
          toolName: resolveToolName(call),
          title: call.title,
          acpKind: call.kind,
          input: coerceRecord(call.rawInput),
          rawInput: call.rawInput,
          status: call.status,
          content: (call.content ?? []).map(translateToolContent),
          locations: (call.locations ?? []).map((l) => ({ path: l.path, line: l.line })),
        },
      ]
    }
    case "tool_call_update": {
      const upd = u as ToolCallUpdate & { sessionUpdate: "tool_call_update" }
      return [
        {
          kind: "tool-update",
          sessionId,
          callId: upd.toolCallId,
          toolName: resolveToolName(upd),
          title: upd.title ?? undefined,
          status: upd.status ?? undefined,
          input: upd.rawInput !== undefined ? coerceRecord(upd.rawInput) : undefined,
          rawInput: upd.rawInput,
          rawOutput: upd.rawOutput,
          content: (upd.content ?? []).map(translateToolContent),
          locations: (upd.locations ?? []).map((l) => ({ path: l.path, line: l.line })),
        },
      ]
    }

    case "plan": {
      const plan = u as Plan & { sessionUpdate: "plan" }
      return [{ kind: "plan", sessionId, entries: plan.entries }]
    }

    case "available_commands_update": {
      return [
        {
          kind: "commands",
          sessionId,
          commands: (u.availableCommands as AvailableCommand[]).map((c) => ({
            name: c.name,
            description: c.description,
            hint: c.input?.hint ?? undefined,
          })),
        },
      ]
    }

    case "current_mode_update": {
      const mode = u as CurrentModeUpdate & { sessionUpdate: "current_mode_update" }
      return [{ kind: "mode", sessionId, modeId: mode.currentModeId }]
    }

    case "usage_update": {
      return [
        {
          kind: "usage",
          sessionId,
          used: (u as { used: number }).used,
          size: (u as { size: number }).size,
          cost: (u as { cost?: Cost | null }).cost,
        },
      ]
    }

    case "session_info_update": {
      const meta = (u._meta ?? {}) as Record<string, unknown>
      return [{ kind: "session-info", sessionId, meta }]
    }

    default:
      return [{ kind: "unknown", sessionId, type, raw: u }]
  }
}

/**
 * Map an ACP `ToolCall.kind` + `_meta.claudeCode.toolName` to a human
 * toolName usable by turing. Priority:
 *   1. Claude Code's own `_meta.claudeCode.toolName` (most specific)
 *   2. A mapping from ACP `kind` to a turing-compatible name
 *   3. "tool" fallback
 */
export function resolveToolName(call: ToolCall | ToolCallUpdate): string {
  const claudeMeta = call._meta?.claudeCode as { toolName?: string } | undefined
  if (claudeMeta?.toolName) {
    return normalizeToolName(claudeMeta.toolName)
  }
  const kind = "kind" in call ? call.kind : undefined
  if (kind) return TOOL_KIND_TO_NAME[kind]
  return "tool"
}

export const TOOL_KIND_TO_NAME: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "remove",
  move: "move",
  search: "grep",
  execute: "bash",
  think: "think",
  fetch: "webfetch",
  switch_mode: "switch_mode",
  other: "tool",
}

/**
 * Normalize Claude Code's PascalCase tool names to turing's
 * lowercase convention. Preserves `mcp__*` namespace separators.
 */
export function normalizeToolName(name: string): string {
  if (name.startsWith("mcp__")) return name
  return name.charAt(0).toLowerCase() + name.slice(1)
}

function contentToText(content: ContentBlock | ContentBlock[] | undefined): string {
  if (!content) return ""
  const arr = Array.isArray(content) ? content : [content]
  let out = ""
  for (const block of arr) {
    if (block.type === "text") out += block.text
  }
  return out
}

function coerceRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function translateToolContent(c: ToolCallContent): TranslatedToolContent {
  switch (c.type) {
    case "content": {
      const block = c.content
      if (block.type === "text") return { type: "text", text: block.text }
      if (block.type === "image") return { type: "image", mimeType: block.mimeType, data: block.data }
      if (block.type === "audio") return { type: "audio", mimeType: block.mimeType, data: block.data }
      if (block.type === "resource_link")
        return {
          type: "resource-link",
          uri: block.uri,
          name: block.name,
          description: block.description ?? undefined,
          mimeType: block.mimeType ?? undefined,
        }
      if (block.type === "resource") return { type: "resource", resource: block.resource }
      return { type: "text", text: JSON.stringify(block) }
    }
    case "diff":
      return {
        type: "diff",
        path: c.path,
        oldText: c.oldText,
        newText: c.newText,
      }
    case "terminal":
      return { type: "terminal", terminalId: c.terminalId }
    default:
      return { type: "text", text: JSON.stringify(c) }
  }
}
