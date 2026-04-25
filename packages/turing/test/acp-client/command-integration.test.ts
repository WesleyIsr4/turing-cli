import { afterEach, describe, expect, test } from "bun:test"
import { acpCommands } from "@/acp-client"
import { acpCommandToInfo, collectAcpCommands, findAcpCommand } from "@/command/acp"

afterEach(() => {
  for (const s of acpCommands.listSessions()) acpCommands.clear(s)
})

describe("command/acp — acpCommandToInfo", () => {
  test("produces passthrough template with source 'acp-agent'", () => {
    const info = acpCommandToInfo({ name: "commit", description: "Create commit", hint: "[msg]" })
    expect(info.source).toBe("acp-agent")
    expect(info.template).toBe("/commit $ARGUMENTS")
    expect(info.hints).toEqual(["[msg]"])
    expect(info.description).toBe("Create commit")
  })

  test("falls back to $ARGUMENTS hint when no hint provided", () => {
    const info = acpCommandToInfo({ name: "plain", description: "no hint" })
    expect(info.hints).toEqual(["$ARGUMENTS"])
  })
})

describe("command/acp — findAcpCommand", () => {
  test("finds command from any session", () => {
    acpCommands.set("s1", [{ name: "commit", description: "Commit" }])
    acpCommands.set("s2", [{ name: "review", description: "Review" }])
    expect(findAcpCommand("commit")?.name).toBe("commit")
    expect(findAcpCommand("review")?.name).toBe("review")
  })

  test("returns undefined when command doesn't exist anywhere", () => {
    acpCommands.set("s1", [{ name: "x", description: "x" }])
    expect(findAcpCommand("does-not-exist")).toBeUndefined()
  })

  test("first session wins on name collision", () => {
    acpCommands.set("alpha", [{ name: "foo", description: "from alpha" }])
    acpCommands.set("beta", [{ name: "foo", description: "from beta" }])
    const info = findAcpCommand("foo")
    expect(info?.description).toBe("from alpha")
  })
})

describe("command/acp — collectAcpCommands", () => {
  test("returns all unique commands across sessions", () => {
    acpCommands.set("s1", [
      { name: "a", description: "A" },
      { name: "b", description: "B" },
    ])
    acpCommands.set("s2", [
      { name: "c", description: "C" },
      { name: "a", description: "A dup" }, // dup on name
    ])
    const list = collectAcpCommands([])
    const names = list.map((c) => c.name).sort()
    expect(names).toEqual(["a", "b", "c"])
  })

  test("skips commands that already exist in the base set", () => {
    acpCommands.set("s1", [
      { name: "init", description: "override built-in init" },
      { name: "commit", description: "Commit" },
    ])
    const list = collectAcpCommands(["init"])
    expect(list.map((c) => c.name)).toEqual(["commit"])
  })

  test("returns [] when registry empty", () => {
    expect(collectAcpCommands([])).toEqual([])
  })
})
