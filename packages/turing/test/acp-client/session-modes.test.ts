import { describe, expect, test } from "bun:test"
import { ACPSessionPool } from "@/acp-client/session-pool"

describe("ACPSessionPool modes + models (E2E)", () => {
  test("captures availableModes and availableModels from session/new response", async () => {
    const pool = new ACPSessionPool()
    try {
      const a = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "modes-test",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      expect(a.ok).toBe(true)
      if (!a.ok) throw new Error("expected ok")

      const entry = a.entry
      expect(entry.availableModes.length).toBeGreaterThan(0)
      expect(entry.availableModes.map((m) => m.id)).toContain("default")
      expect(entry.availableModes.map((m) => m.id)).toContain("plan")

      expect(entry.availableModels.length).toBeGreaterThan(0)
      expect(entry.availableModels.some((m) => m.modelId === "default" || m.modelId === "sonnet")).toBe(true)

      expect(entry.currentModeId).toBeDefined()
      expect(entry.currentModelId).toBeDefined()
    } finally {
      await pool.closeAll()
    }
  }, 120000)

  test("setMode switches and updates entry.currentModeId", async () => {
    const pool = new ACPSessionPool()
    try {
      const a = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "mode-switch",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      if (!a.ok) throw new Error("expected ok")
      const before = a.entry.currentModeId

      await pool.setMode("claude-code", "mode-switch", "plan")
      expect(a.entry.currentModeId).toBe("plan")
      expect(a.entry.currentModeId).not.toBe(before ?? "")
    } finally {
      await pool.closeAll()
    }
  }, 120000)

  test("setModel switches and updates entry.currentModelId", async () => {
    const pool = new ACPSessionPool()
    try {
      const a = await pool.acquire({
        agentId: "claude-code",
        turingSessionId: "model-switch",
        cwd: "/tmp",
        onSessionUpdate: () => {},
      })
      if (!a.ok) throw new Error("expected ok")

      await pool.setModel("claude-code", "model-switch", "haiku")
      expect(a.entry.currentModelId).toBe("haiku")
    } finally {
      await pool.closeAll()
    }
  }, 120000)

  test("setMode on nonexistent entry is a no-op", async () => {
    const pool = new ACPSessionPool()
    await pool.setMode("claude-code", "nothing-here", "plan")
    expect(pool.getEntry("claude-code", "nothing-here")).toBeUndefined()
  })
})
