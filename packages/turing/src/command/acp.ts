import { acpCommands, type ACPCommand } from "@/acp-client"

export interface ACPCommandInfo {
  name: string
  description?: string
  source: "acp-agent"
  template: string
  hints: string[]
  subtask?: boolean
  agent?: string
  model?: string
}

/**
 * Build a passthrough Command.Info for an ACP agent command. The template is
 * literally `/name $ARGUMENTS` — when the turing command pipeline renders
 * it, the user message becomes "/name args", which Claude Code's ACP agent
 * recognizes and dispatches as its own slash command.
 */
export function acpCommandToInfo(cmd: ACPCommand): ACPCommandInfo {
  return {
    name: cmd.name,
    description: cmd.description,
    source: "acp-agent",
    template: `/${cmd.name} $ARGUMENTS`,
    hints: cmd.hint ? [cmd.hint] : ["$ARGUMENTS"],
  }
}

export function findAcpCommand(name: string): ACPCommandInfo | undefined {
  for (const sessionId of acpCommands.listSessions()) {
    const match = acpCommands.get(sessionId).find((c) => c.name === name)
    if (match) return acpCommandToInfo(match)
  }
  return undefined
}

export function collectAcpCommands(existingNames: Iterable<string>): ACPCommandInfo[] {
  const existing = new Set(existingNames)
  const out: ACPCommandInfo[] = []
  const seen = new Set<string>()
  for (const sessionId of acpCommands.listSessions()) {
    for (const cmd of acpCommands.get(sessionId)) {
      if (existing.has(cmd.name) || seen.has(cmd.name)) continue
      seen.add(cmd.name)
      out.push(acpCommandToInfo(cmd))
    }
  }
  return out
}
