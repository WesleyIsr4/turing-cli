import { describe, expect, test } from "bun:test"
import { AGENT_REGISTRY, getAgent, listAgents } from "@/acp-client/registry"
import { checkAgentAuth } from "@/acp-client/auth"

describe("ACP agent registry", () => {
  test("has claude-code agent configured", () => {
    const a = getAgent("claude-code")
    expect(a.id).toBe("claude-code")
    // The command resolves to one of:
    //   - npx (fallback)
    //   - a runtime path + bundled dist JS (node_modules hit)
    //   - a direct binary path (PATH hit)
    //   - an env override
    // All are acceptable — we only care that the agent is resolvable.
    expect(a.command).toBeTruthy()
    expect(a.authCheckCommand).toBeDefined()
  })

  test("lists all registered agents", () => {
    const list = listAgents()
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.map((a) => a.id)).toContain("claude-code")
  })

  test("throws on unknown agent", () => {
    expect(() => getAgent("does-not-exist")).toThrow()
  })

  test("all registered agents have required fields", () => {
    for (const [id, agent] of Object.entries(AGENT_REGISTRY)) {
      expect(agent.id).toBe(id)
      expect(agent.label).toBeTruthy()
      expect(agent.command).toBeTruthy()
      expect(Array.isArray(agent.args)).toBe(true)
    }
  })
})

describe("checkAgentAuth", () => {
  test("returns ok:true for agent without authCheckCommand", async () => {
    const result = await checkAgentAuth({
      id: "test",
      label: "Test",
      command: "echo",
      args: [],
    })
    expect(result.ok).toBe(true)
  })

  test("returns ok:false when auth command fails", async () => {
    const result = await checkAgentAuth({
      id: "test",
      label: "Test",
      command: "echo",
      args: [],
      authCheckCommand: { command: "false", args: [] },
      authHint: "try again",
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("try again")
  })

  test("returns ok:true when auth command succeeds", async () => {
    const result = await checkAgentAuth({
      id: "test",
      label: "Test",
      command: "echo",
      args: [],
      authCheckCommand: { command: "true", args: [] },
    })
    expect(result.ok).toBe(true)
  })

  test("returns ok:false when auth binary missing", async () => {
    const result = await checkAgentAuth({
      id: "test",
      label: "Test",
      command: "echo",
      args: [],
      authCheckCommand: { command: "definitely-not-a-real-command-xyz-12345", args: [] },
      authHint: "install it",
    })
    expect(result.ok).toBe(false)
  })
})
