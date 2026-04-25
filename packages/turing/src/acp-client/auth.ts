import { Log } from "@/util"
import type { AgentBinary } from "./registry"

const log = Log.create({ service: "acp-client-auth" })

export interface AuthCheckResult {
  ok: boolean
  message?: string
}

/**
 * Run the optional auth-check command for an agent (e.g. `claude auth status`)
 * and return whether the user is authenticated. If the agent has no auth check
 * configured we assume ok — the subprocess will fail at spawn if not.
 */
export async function checkAgentAuth(agent: AgentBinary): Promise<AuthCheckResult> {
  if (!agent.authCheckCommand) return { ok: true }

  const { command, args } = agent.authCheckCommand
  try {
    const proc = Bun.spawn({
      cmd: [command, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    if (exitCode === 0) return { ok: true }

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    log.warn("auth check failed", {
      agent: agent.id,
      exitCode,
      stdout: stdout.slice(0, 300),
      stderr: stderr.slice(0, 300),
    })
    return {
      ok: false,
      message: agent.authHint ?? `${agent.label} is not authenticated (exit ${exitCode}).`,
    }
  } catch (e) {
    log.error("auth check threw", { agent: agent.id, error: String(e) })
    return {
      ok: false,
      message: `${agent.label} auth check failed: ${(e as Error).message}. ${agent.authHint ?? ""}`.trim(),
    }
  }
}
