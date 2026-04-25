import { describe, expect, test } from "bun:test"
import { configToAcpMcpServers } from "@/acp-client/mcp-config"

describe("configToAcpMcpServers", () => {
  test("returns empty array for missing config", () => {
    expect(configToAcpMcpServers(undefined)).toEqual([])
    expect(configToAcpMcpServers({ mcp: {} } as any)).toEqual([])
  })

  test("translates stdio command-based servers", () => {
    const cfg = {
      mcp: {
        "my-mcp": {
          command: "node",
          args: ["server.js"],
          environment: { DEBUG: "1" },
        },
      },
    } as any
    const result = configToAcpMcpServers(cfg)
    expect(result).toHaveLength(1)
    const s = result[0] as any
    expect(s.name).toBe("my-mcp")
    expect(s.command).toBe("node")
    expect(s.args).toEqual(["server.js"])
    expect(s.env).toEqual([{ name: "DEBUG", value: "1" }])
  })

  test("translates remote http servers", () => {
    const cfg = {
      mcp: {
        remote: {
          type: "remote",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer X" },
        },
      },
    } as any
    const result = configToAcpMcpServers(cfg)
    expect(result).toHaveLength(1)
    const s = result[0] as any
    expect(s.type).toBe("http")
    expect(s.url).toBe("https://api.example.com/mcp")
    expect(s.headers).toEqual([{ name: "Authorization", value: "Bearer X" }])
  })

  test("translates remote sse when transport: sse", () => {
    const cfg = {
      mcp: {
        sse: {
          type: "remote",
          transport: "sse",
          url: "https://api.example.com/sse",
        },
      },
    } as any
    const result = configToAcpMcpServers(cfg)
    const s = result[0] as any
    expect(s.type).toBe("sse")
  })

  test("skips malformed entries", () => {
    const cfg = {
      mcp: {
        bad1: null,
        bad2: { type: "remote" },
        bad3: { type: "local" },
        good: { command: "ls", args: [] },
      },
    } as any
    const result = configToAcpMcpServers(cfg)
    expect(result).toHaveLength(1)
    expect((result[0] as any).name).toBe("good")
  })

  test("accepts `env` alias for environment", () => {
    const cfg = {
      mcp: { x: { command: "x", args: [], env: { K: "v" } } },
    } as any
    const result = configToAcpMcpServers(cfg)
    expect((result[0] as any).env).toEqual([{ name: "K", value: "v" }])
  })
})
