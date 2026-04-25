import { afterEach, describe, expect, test } from "bun:test"
import { acpCommands } from "@/acp-client/commands-registry"

afterEach(() => {
  for (const s of acpCommands.listSessions()) acpCommands.clear(s)
})

describe("acpCommands registry", () => {
  test("stores and retrieves commands per session", () => {
    acpCommands.set("s1", [{ name: "init", description: "Init", hint: "[name]" }])
    expect(acpCommands.get("s1")).toEqual([{ name: "init", description: "Init", hint: "[name]" }])
  })

  test("returns empty array for unknown session", () => {
    expect(acpCommands.get("nope")).toEqual([])
  })

  test("has() checks command presence", () => {
    acpCommands.set("s1", [{ name: "commit", description: "Commit" }])
    expect(acpCommands.has("s1", "commit")).toBe(true)
    expect(acpCommands.has("s1", "push")).toBe(false)
    expect(acpCommands.has("other", "commit")).toBe(false)
  })

  test("clear() drops session commands", () => {
    acpCommands.set("s1", [{ name: "x", description: "x" }])
    expect(acpCommands.get("s1")).toHaveLength(1)
    acpCommands.clear("s1")
    expect(acpCommands.get("s1")).toHaveLength(0)
  })

  test("overwrites previous commands for same session", () => {
    acpCommands.set("s1", [{ name: "a", description: "A" }])
    acpCommands.set("s1", [{ name: "b", description: "B" }, { name: "c", description: "C" }])
    const list = acpCommands.get("s1")
    expect(list.map((c) => c.name)).toEqual(["b", "c"])
  })

  test("listSessions returns all session IDs with commands", () => {
    acpCommands.set("a", [{ name: "x", description: "x" }])
    acpCommands.set("b", [{ name: "y", description: "y" }])
    expect(acpCommands.listSessions().sort()).toEqual(["a", "b"])
  })
})
