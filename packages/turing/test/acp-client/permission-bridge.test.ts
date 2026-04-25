import { describe, expect, test } from "bun:test"
import { createOpencodePermissionResolver } from "@/acp-client/permission-bridge"
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"

function makeReq(overrides: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc1",
      title: "Run ls",
      rawInput: { command: "ls" },
      _meta: { claudeCode: { toolName: "Bash" } },
      status: "pending",
    } as any,
    options: [
      { optionId: "ao", kind: "allow_once", name: "Allow once" },
      { optionId: "aa", kind: "allow_always", name: "Always allow" },
      { optionId: "ro", kind: "reject_once", name: "Reject once" },
    ],
    ...overrides,
  } as any
}

describe("createOpencodePermissionResolver", () => {
  test("selects allow_once when ask resolves", async () => {
    const asks: unknown[] = []
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask(input) {
        asks.push(input)
      },
    })
    const resp = await resolver(makeReq())
    expect(resp.outcome).toEqual({ outcome: "selected", optionId: "ao" })
    expect(asks).toHaveLength(1)
    expect((asks[0] as any).permission).toBe("bash")
  })

  test("prefers allow_always if only that is available", async () => {
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask() {},
    })
    const req = makeReq({
      options: [{ optionId: "aa", kind: "allow_always", name: "Always" }],
    } as any)
    const resp = await resolver(req)
    expect(resp.outcome).toEqual({ outcome: "selected", optionId: "aa" })
  })

  test("selects reject_once when ask throws", async () => {
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask() {
        throw new Error("rejected")
      },
    })
    const resp = await resolver(makeReq())
    expect(resp.outcome).toEqual({ outcome: "selected", optionId: "ro" })
  })

  test("cancels when no allow option is offered", async () => {
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask() {},
    })
    const req = makeReq({
      options: [{ optionId: "ro", kind: "reject_once", name: "Reject" }],
    } as any)
    const resp = await resolver(req)
    expect(resp.outcome).toEqual({ outcome: "cancelled" })
  })

  test("cancels when ask fails and no reject option", async () => {
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask() {
        throw new Error("x")
      },
    })
    const req = makeReq({
      options: [{ optionId: "ao", kind: "allow_once", name: "Allow" }],
    } as any)
    const resp = await resolver(req)
    expect(resp.outcome).toEqual({ outcome: "cancelled" })
  })

  test("extracts tool name from claudeCode meta", async () => {
    let capturedPermission: string | undefined
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask(input) {
        capturedPermission = input.permission
      },
    })
    await resolver(makeReq())
    expect(capturedPermission).toBe("bash")
  })

  test("falls back to 'tool' when no meta", async () => {
    let capturedPermission: string | undefined
    const resolver = createOpencodePermissionResolver({
      turingSessionId: "s1",
      async ask(input) {
        capturedPermission = input.permission
      },
    })
    const req = makeReq({
      toolCall: {
        toolCallId: "tc1",
        title: "?",
      } as any,
    })
    await resolver(req)
    expect(capturedPermission).toBe("tool")
  })
})
