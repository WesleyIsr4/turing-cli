import { describe, expect, test } from "bun:test"
import { resolveMemoryLocations } from "@/memory"

describe("resolveMemoryLocations", () => {
  test("user path is shared across workspaces", () => {
    const a = resolveMemoryLocations("/proj/a")
    const b = resolveMemoryLocations("/proj/b")
    expect(a.userPath).toBe(b.userPath)
    expect(a.userPath.endsWith("/USER.md")).toBe(true)
  })

  test("memory path differs per workspace", () => {
    const a = resolveMemoryLocations("/proj/a")
    const b = resolveMemoryLocations("/proj/b")
    expect(a.memoryPath).not.toBe(b.memoryPath)
  })

  test("same workspace yields stable key", () => {
    const a = resolveMemoryLocations("/proj/a")
    const b = resolveMemoryLocations("/proj/a")
    expect(a.memoryPath).toBe(b.memoryPath)
  })
})
