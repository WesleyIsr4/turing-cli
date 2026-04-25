import { Log } from "@/util"

const log = Log.create({ service: "acp-client-commands-registry" })

export interface ACPCommand {
  name: string
  description: string
  hint?: string
}

/**
 * Stores slash commands advertised by an ACP agent for a given turing
 * session. ACP agents emit `available_commands_update` notifications each
 * time their command surface changes (e.g. new Skills loaded, MCP prompts
 * updated). This registry keeps the latest snapshot per session.
 *
 * For now the registry is observational — the TUI or Command.Service
 * integration can query it to display / invoke commands, but the default
 * turing Command.Service doesn't read from here yet. See the acp-client
 * README for the planned integration points.
 */
class ACPCommandsRegistry {
  #bySession = new Map<string, ACPCommand[]>()

  set(turingSessionId: string, commands: ACPCommand[]) {
    this.#bySession.set(turingSessionId, commands)
    log.debug("commands updated", { sessionId: turingSessionId, count: commands.length })
  }

  get(turingSessionId: string): ACPCommand[] {
    return this.#bySession.get(turingSessionId) ?? []
  }

  has(turingSessionId: string, name: string): boolean {
    const list = this.#bySession.get(turingSessionId)
    if (!list) return false
    return list.some((c) => c.name === name)
  }

  clear(turingSessionId: string) {
    this.#bySession.delete(turingSessionId)
  }

  listSessions(): string[] {
    return [...this.#bySession.keys()]
  }
}

export const acpCommands = new ACPCommandsRegistry()
