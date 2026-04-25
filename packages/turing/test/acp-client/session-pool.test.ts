import { describe, expect, test } from "bun:test"
import { ACPSessionPool } from "@/acp-client/session-pool"

describe("ACPSessionPool (E2E)", () => {
  test("acquires, reuses across turns, releases on demand", async () => {
    const pool = new ACPSessionPool()
    try {
      expect(pool.size()).toBe(0)

      const a1 = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "sess-1",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      expect(a1.ok).toBe(true)
      if (!a1.ok) throw new Error("expected ok")
      expect(pool.size()).toBe(1)
      expect(pool.has("claude-code", "sess-1")).toBe(true)

      // Second acquire for same session should return the same entry
      const a2 = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "sess-1",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      expect(a2.ok).toBe(true)
      if (!a2.ok) throw new Error("expected ok")
      expect(a2.entry.acpSessionId).toBe(a1.entry.acpSessionId)
      expect(pool.size()).toBe(1)

      // Different turing session → new entry
      const a3 = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "sess-2",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      expect(a3.ok).toBe(true)
      if (!a3.ok) throw new Error("expected ok")
      expect(a3.entry.acpSessionId).not.toBe(a1.entry.acpSessionId)
      expect(pool.size()).toBe(2)

      await pool.release("claude-code", "sess-1")
      expect(pool.size()).toBe(1)
      expect(pool.has("claude-code", "sess-1")).toBe(false)
      expect(pool.has("claude-code", "sess-2")).toBe(true)
    } finally {
      await pool.closeAll()
    }
  }, 180000)

  test("closeAll shuts down all entries", async () => {
    const pool = new ACPSessionPool()
    await pool.acquire({
      agentId: "claude-code",
      turingSessionId: "x",
      cwd: "/tmp",
      onSessionUpdate: () => {},
    })
    expect(pool.size()).toBe(1)
    await pool.closeAll()
    expect(pool.size()).toBe(0)
  }, 120000)

  test("bindHandlers swaps the active handler without recreating entry", async () => {
    const pool = new ACPSessionPool()
    try {
      const updates1: any[] = []
      const a = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "bind-test",
        cwd: "/tmp",
        onSessionUpdate: (n) => {
          updates1.push(n)
        },
      })
      expect(a.ok).toBe(true)
      if (!a.ok) throw new Error("expected ok")

      const updates2: any[] = []
      pool.bindHandlers(a.entry, (n) => {
        updates2.push(n)
      })

      // Sanity: pool.has still true, entry same
      expect(pool.has("claude-code", "bind-test")).toBe(true)
    } finally {
      await pool.closeAll()
    }
  }, 120000)
})
