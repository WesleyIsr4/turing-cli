import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  TOOL_KIND_TO_NAME,
  normalizeToolName,
  resolveToolName,
  translate,
} from "@/acp-client/translator"
import type { SessionNotification } from "@agentclientprotocol/sdk"

const FIXTURES = join(import.meta.dir, "fixtures")

function loadNotif(file: string): SessionNotification {
  const raw = JSON.parse(readFileSync(join(FIXTURES, file), "utf8"))
  return raw.params as SessionNotification
}

describe("translator — tool name resolution", () => {
  test("claudeCode._meta.toolName wins over kind", () => {
    const name = resolveToolName({
      title: "Run echo",
      toolCallId: "x",
      kind: "execute",
      _meta: { claudeCode: { toolName: "Bash" } },
    } as any)
    expect(name).toBe("bash")
  })

  test("falls back to kind mapping when no meta", () => {
    const name = resolveToolName({
      title: "searching",
      toolCallId: "x",
      kind: "search",
    } as any)
    expect(name).toBe("grep")
  })

  test("falls back to 'tool' when no meta and no kind", () => {
    const name = resolveToolName({ title: "?", toolCallId: "x" } as any)
    expect(name).toBe("tool")
  })

  test("preserves mcp__* prefix in normalization", () => {
    expect(normalizeToolName("mcp__github__list_issues")).toBe("mcp__github__list_issues")
  })

  test("lowercases first char of PascalCase tool names", () => {
    expect(normalizeToolName("Bash")).toBe("bash")
    expect(normalizeToolName("Read")).toBe("read")
    expect(normalizeToolName("WebFetch")).toBe("webFetch")
  })

  test("kind map covers all ToolKind variants", () => {
    expect(Object.keys(TOOL_KIND_TO_NAME).sort()).toEqual(
      ["delete", "edit", "execute", "fetch", "move", "other", "read", "search", "switch_mode", "think"].sort(),
    )
  })
})

describe("translator — agent_message_chunk", () => {
  test("emits empty-event suppression for empty text chunks", () => {
    const n = loadNotif("05-notif-agent-message-chunk.json")
    const events = translate(n)
    expect(events).toHaveLength(0)
  })

  test("emits a text event for non-empty chunk", () => {
    const n: SessionNotification = {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } } as any,
    }
    const events = translate(n)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("text")
    if (events[0].kind === "text") {
      expect(events[0].text).toBe("hi ")
      expect(events[0].sessionId).toBe("s1")
    }
  })
})

describe("translator — tool_call", () => {
  test("maps Bash execute tool to 'bash' with pending status", () => {
    const n = loadNotif("06-notif-tool-call.json")
    const events = translate(n)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe("tool-start")
    if (ev.kind === "tool-start") {
      expect(ev.toolName).toBe("bash")
      expect(ev.acpKind).toBe("execute")
      expect(ev.status).toBe("pending")
      expect(ev.callId).toBe("toolu_01YGTctgeQs4jUJ5oMm85cnB")
      expect(ev.title).toBe("Terminal")
    }
  })
})

describe("translator — tool_call_update", () => {
  test("carries output meta for Bash completion", () => {
    const n = loadNotif("06-notif-tool-call-update.json")
    const events = translate(n)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe("tool-update")
    if (ev.kind === "tool-update") {
      expect(ev.callId).toBe("toolu_01YGTctgeQs4jUJ5oMm85cnB")
      expect(ev.toolName).toBe("bash")
    }
  })
})

describe("translator — usage_update", () => {
  test("extracts used/size from flat UsageUpdate payload", () => {
    const n = loadNotif("04-notif-usage-update.json")
    const events = translate(n)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("usage")
    if (events[0].kind === "usage") {
      expect(events[0].used).toBe(46059)
      expect(events[0].size).toBe(200000)
    }
  })
})

describe("translator — available_commands_update", () => {
  test("produces commands event with name/description", () => {
    const n = loadNotif("03-notif-available-commands-update.json")
    const events = translate(n)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("commands")
    if (events[0].kind === "commands") {
      expect(events[0].commands.length).toBeGreaterThan(0)
      for (const c of events[0].commands) {
        expect(c.name).toBeTruthy()
        expect(c.description).toBeTruthy()
      }
    }
  })
})

describe("translator — unknown types", () => {
  test("passes through unknown sessionUpdate types", () => {
    const n: SessionNotification = {
      sessionId: "s1",
      update: { sessionUpdate: "something_new_we_dont_know" as any } as any,
    }
    const events = translate(n)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("unknown")
  })
})
