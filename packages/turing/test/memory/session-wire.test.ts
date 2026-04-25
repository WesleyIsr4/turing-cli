import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildMemoryContextBlock, MemoryStore } from "@/memory"

describe("memory <-> ACP session wiring", () => {
  let tmp: string

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  })

  test("snapshot captures entries from both stores in deterministic order", () => {
    tmp = mkdtempSync(join(tmpdir(), "opencode-mem-wire-"))
    const store = new MemoryStore({
      userPath: join(tmp, "USER.md"),
      memoryPath: join(tmp, "MEMORY.md"),
    })
    store.add("user", "prefers Portuguese")
    store.add("memory", "project uses bun + hono")

    const snapshot = store.snapshot()
    expect(snapshot.indexOf("USER preferences")).toBeLessThan(snapshot.indexOf("WORKSPACE memory"))

    const block = buildMemoryContextBlock(snapshot)
    expect(block).toMatch(/<memory-context>[\s\S]*<\/memory-context>/)
    expect(block).toContain("prefers Portuguese")
    expect(block).toContain("project uses bun + hono")
    expect(block).toContain("REFERENCE-ONLY")
  })

  test("snapshot is empty when both stores are empty → block is empty", () => {
    tmp = mkdtempSync(join(tmpdir(), "opencode-mem-wire-"))
    const store = new MemoryStore({
      userPath: join(tmp, "USER.md"),
      memoryPath: join(tmp, "MEMORY.md"),
    })
    expect(store.snapshot()).toBe("")
    expect(buildMemoryContextBlock(store.snapshot())).toBe("")
  })

  test("mid-session writes do not mutate the captured snapshot", () => {
    tmp = mkdtempSync(join(tmpdir(), "opencode-mem-wire-"))
    const store = new MemoryStore({
      userPath: join(tmp, "USER.md"),
      memoryPath: join(tmp, "MEMORY.md"),
    })
    store.add("user", "first preference")
    const frozen = buildMemoryContextBlock(store.snapshot())

    // Write happens after the snapshot was taken
    store.add("user", "new preference added mid-session")

    // The frozen snapshot is just a string — it must NOT change
    expect(frozen).toContain("first preference")
    expect(frozen).not.toContain("new preference added mid-session")

    // But a FRESH snapshot reflects both
    const next = buildMemoryContextBlock(store.snapshot())
    expect(next).toContain("new preference added mid-session")
  })
})
