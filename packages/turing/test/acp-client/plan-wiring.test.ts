import { describe, expect, test } from "bun:test"
import { translate } from "@/acp-client"
import type { SessionNotification } from "@agentclientprotocol/sdk"

function planNotif(entries: any[]): SessionNotification {
  return {
    sessionId: "s1",
    update: {
      sessionUpdate: "plan",
      entries,
    } as any,
  }
}

describe("plan translation", () => {
  test("produces single plan event carrying entries", () => {
    const notif = planNotif([
      { content: "Step 1", status: "pending", priority: "high" },
      { content: "Step 2", status: "in_progress", priority: "medium" },
      { content: "Step 3", status: "completed", priority: "low" },
    ])
    const events = translate(notif)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.kind).toBe("plan")
    if (ev.kind === "plan") {
      expect(ev.entries).toHaveLength(3)
      expect((ev.entries[0] as any).content).toBe("Step 1")
      expect((ev.entries[0] as any).priority).toBe("high")
    }
  })

  test("empty plan yields empty entries array", () => {
    const notif = planNotif([])
    const events = translate(notif)
    expect(events).toHaveLength(1)
    if (events[0].kind === "plan") {
      expect(events[0].entries).toHaveLength(0)
    }
  })
})
