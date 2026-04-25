import { Log } from "@/util"
import type { Subprocess } from "bun"

const log = Log.create({ service: "acp-client-subprocess" })

export interface SpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface ACPAgentProcess {
  readonly pid: number | undefined
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly exited: Promise<number | null>
  kill(signal?: NodeJS.Signals | number): void
  shutdown(timeoutMs?: number): Promise<void>
}

/**
 * Spawn an ACP-compatible agent binary (e.g. `claude-agent-acp`) as a child process.
 * stdin/stdout are wired for NDJSON protocol; stderr is logged at debug level.
 */
export function spawnACPAgent(opts: SpawnOptions): ACPAgentProcess {
  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn({
    cmd: [opts.command, ...opts.args],
    cwd: opts.cwd,
    env: filterEnv(opts.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  log.info("spawned", { pid: proc.pid, command: opts.command, args: opts.args })

  pipeStderr(proc).catch((e) => log.debug("stderr pipe ended", { error: String(e) }))

  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      proc.stdin.write(chunk)
      await proc.stdin.flush()
    },
    close() {
      proc.stdin.end()
    },
    abort() {
      try {
        proc.stdin.end()
      } catch {}
    },
  })

  return {
    pid: proc.pid,
    stdin,
    stdout: proc.stdout,
    exited: proc.exited,
    kill(signal = "SIGTERM") {
      if (proc.killed) return
      try {
        proc.kill(signal as any)
      } catch (e) {
        log.debug("kill threw", { error: String(e) })
      }
    },
    async shutdown(timeoutMs = 5000) {
      if (proc.killed) {
        await proc.exited
        return
      }
      try {
        proc.stdin.end()
      } catch {}
      try {
        proc.kill("SIGTERM")
      } catch {}
      const timed = Promise.race([
        proc.exited.then(() => "exited"),
        new Promise<string>((r) => setTimeout(() => r("timeout"), timeoutMs)),
      ])
      if ((await timed) === "timeout") {
        log.warn("SIGTERM timeout, escalating to SIGKILL", { pid: proc.pid })
        try {
          proc.kill("SIGKILL")
        } catch {}
        await proc.exited
      }
    },
  }
}

function filterEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const base = { ...process.env } as Record<string, string | undefined>
  if (extra) Object.assign(base, extra)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v
  return out
}

async function pipeStderr(proc: Subprocess<"pipe", "pipe", "pipe">) {
  const decoder = new TextDecoder()
  let carry = ""
  const reader = proc.stderr.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    carry += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl)
      carry = carry.slice(nl + 1)
      if (line.trim()) log.debug("agent stderr", { line, pid: proc.pid })
    }
  }
  if (carry.trim()) log.debug("agent stderr", { line: carry, pid: proc.pid })
}
