import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { PermissionResolver } from "./handler"
import { Log } from "@/util"

const log = Log.create({ service: "acp-client-permission-bridge" })

export interface OpencodePermissionAsk {
  /**
   * Ask the user for permission. Resolves if approved, rejects on any
   * denial/error. Implementations wrap turing's Permission.Service.ask.
   */
  ask: (input: {
    sessionID: string
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
    always: string[]
    ruleset: unknown[]
    tool?: { messageID: string; callID: string }
  }) => Promise<void>
  /** Opencode session ID the user is currently in. */
  turingSessionId: string
  /** Optional messageID + callID for the tool call under permission. */
  toolContext?: { messageID: string }
}

/**
 * Build a PermissionResolver backed by turing's Permission.Service.
 * The resolver translates ACP requestPermission payloads into
 * turing permission asks, then maps the outcome back to an ACP option.
 */
export function createOpencodePermissionResolver(
  opts: OpencodePermissionAsk,
): PermissionResolver {
  return async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const allowOption = pickOption(req.options, "allow_once") ?? pickOption(req.options, "allow_always")
    const rejectOption = pickOption(req.options, "reject_once") ?? pickOption(req.options, "reject_always")

    if (!allowOption) {
      log.warn("permission request has no allow option; cancelling", {
        options: req.options.map((o) => o.kind),
      })
      return { outcome: { outcome: "cancelled" } }
    }

    const tool = req.toolCall as ToolCallUpdate
    const toolName = resolveAcpToolName(tool)
    const patterns = [toolName, tool.title ?? toolName]

    try {
      await opts.ask({
        sessionID: opts.turingSessionId,
        permission: toolName,
        patterns,
        metadata: {
          acpToolCallId: tool.toolCallId,
          title: tool.title,
          rawInput: tool.rawInput,
        },
        always: [toolName],
        ruleset: [],
        tool: opts.toolContext
          ? { messageID: opts.toolContext.messageID, callID: tool.toolCallId }
          : undefined,
      })
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } }
    } catch (err) {
      log.info("user denied permission", { toolName, error: String(err) })
      if (rejectOption) {
        return { outcome: { outcome: "selected", optionId: rejectOption.optionId } }
      }
      return { outcome: { outcome: "cancelled" } }
    }
  }
}

function pickOption(
  options: PermissionOption[],
  kind: PermissionOption["kind"],
): PermissionOption | undefined {
  return options.find((o) => o.kind === kind)
}

function resolveAcpToolName(tool: ToolCallUpdate): string {
  const meta = tool._meta?.claudeCode as { toolName?: string } | undefined
  if (meta?.toolName) return meta.toolName.charAt(0).toLowerCase() + meta.toolName.slice(1)
  return "tool"
}
