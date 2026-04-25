import { Log } from "@/util"
import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk"
import { readFile, writeFile } from "fs/promises"

const log = Log.create({ service: "acp-client-handler" })

export type PermissionResolver = (
  req: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>

export type SessionUpdateHandler = (params: SessionNotification) => void | Promise<void>

export interface HandlerOptions {
  onSessionUpdate: SessionUpdateHandler
  resolvePermission?: PermissionResolver
}

/**
 * Implements the ACP Client interface. This is what the agent (claude-agent-acp)
 * calls on us. Responsibilities:
 *  - Fan out session/update notifications to the translator
 *  - Answer requestPermission (delegated to resolvePermission if provided, else auto-allow)
 *  - Serve readTextFile / writeTextFile against the local filesystem
 *  - Reject terminal methods (not advertised as a capability)
 */
export function createClientHandler(opts: HandlerOptions): Client {
  const resolvePermission =
    opts.resolvePermission ?? (async (req) => autoAllowPermission(req))

  return {
    async sessionUpdate(params) {
      await opts.onSessionUpdate(params)
    },

    async requestPermission(params) {
      return resolvePermission(params)
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const content = await readFile(params.path, "utf8")
      return { content: sliceContent(content, params.line, params.limit) }
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      await writeFile(params.path, params.content, "utf8")
      return {}
    },

    async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
      throw capabilityNotSupported("createTerminal")
    },
    async terminalOutput(_params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      throw capabilityNotSupported("terminalOutput")
    },
    async releaseTerminal(_params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse | void> {
      throw capabilityNotSupported("releaseTerminal")
    },
    async waitForTerminalExit(_params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
      throw capabilityNotSupported("waitForTerminalExit")
    },
    async killTerminal(_params: KillTerminalRequest): Promise<KillTerminalResponse | void> {
      throw capabilityNotSupported("killTerminal")
    },
  }
}

function capabilityNotSupported(method: string): Error {
  log.warn("agent invoked unsupported capability", { method })
  return new Error(`Client does not support ${method}`)
}

function sliceContent(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content
  const lines = content.split("\n")
  const start = line != null ? Math.max(0, line - 1) : 0
  const end = limit != null ? start + limit : lines.length
  return lines.slice(start, end).join("\n")
}

function autoAllowPermission(req: RequestPermissionRequest): RequestPermissionResponse {
  const allowOption = req.options.find(
    (o) => o.kind === "allow_always" || o.kind === "allow_once",
  )
  if (!allowOption) {
    // No allow option advertised: cancel the request
    return { outcome: { outcome: "cancelled" } }
  }
  log.debug("auto-allow permission", { optionId: allowOption.optionId })
  return {
    outcome: {
      outcome: "selected",
      optionId: allowOption.optionId,
    },
  }
}
