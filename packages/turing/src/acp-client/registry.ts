import { existsSync } from "fs"
import { createRequire } from "module"
import { delimiter, join } from "path"

/**
 * Registry of ACP-speaking agent binaries. Designed to grow:
 * add Codex ACP, Gemini CLI ACP, Copilot ACP, etc. using the same entries.
 *
 * Registered binaries are expected to:
 *   - be installable via npx (or already be on PATH)
 *   - speak ACP protocol version 1 over stdio
 *   - honor standard Client handlers (sessionUpdate, requestPermission, fs ops)
 */

export interface AgentBinary {
  id: string
  label: string
  command: string
  args: string[]
  /** Extra env vars to pass to the subprocess. Merged over process.env. */
  env?: Record<string, string>
  /** Optional shell command to verify user is authenticated for this agent. */
  authCheckCommand?: { command: string; args: string[] }
  /** Human-readable hint when auth check fails. */
  authHint?: string
}

interface AgentSpec {
  id: string
  label: string
  /** Name of the CLI binary to look for on PATH before falling back to npx. */
  directBinaryName: string
  /** npm package to spawn via `npx -y` when binary is not on PATH. */
  npmPackage: string
  authCheckCommand?: { command: string; args: string[] }
  authHint?: string
  /**
   * Optional functions that produce env vars to pass to the subprocess.
   * Computed lazily at spawn time so the resolution happens after any
   * runtime env changes (e.g. CLAUDE_CODE_EXECUTABLE set via config).
   */
  envProviders?: Array<() => Record<string, string>>
}

const SPECS: Record<string, AgentSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    directBinaryName: "claude-agent-acp",
    npmPackage: "@agentclientprotocol/claude-agent-acp",
    authCheckCommand: {
      command: "claude",
      args: ["auth", "status"],
    },
    authHint: "Run `claude auth login` and try again.",
    envProviders: [provideClaudeExecutable],
  },
}

/**
 * Points claude-agent-acp at the user's local `claude` binary via
 * CLAUDE_CODE_EXECUTABLE. Needed when running the bundled claude-agent-acp
 * because Bun's node_modules layout breaks the SDK's optional platform-dep
 * resolution for the bundled claude binary.
 */
function provideClaudeExecutable(): Record<string, string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return {}
  const local = which("claude")
  return local ? { CLAUDE_CODE_EXECUTABLE: local } : {}
}

/**
 * Memoized binary detection per agent id. Probes PATH once per process;
 * spawning is cheap after that.
 */
const resolved = new Map<string, AgentBinary>()

function which(binary: string): string | undefined {
  const path = process.env.PATH
  if (!path) return undefined
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, binary + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve an ACP agent's CLI entrypoint from a bundled npm dep. Works by
 * locating the package's package.json via Node resolution and reading its
 * `bin` field. Returns undefined if the package isn't installed in any
 * ancestor node_modules.
 */
function resolveBundledBin(npmPackage: string, binaryName: string): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const pkgJsonPath = require.resolve(`${npmPackage}/package.json`)
    const pkgJson = require(pkgJsonPath) as { bin?: Record<string, string> | string; main?: string }
    const bin = pkgJson.bin
    const relPath =
      typeof bin === "string" ? bin : typeof bin === "object" && bin ? bin[binaryName] : undefined
    if (!relPath) return undefined
    const pkgDir = pkgJsonPath.slice(0, pkgJsonPath.length - "/package.json".length)
    const resolved = join(pkgDir, relPath)
    if (existsSync(resolved)) return resolved
    return undefined
  } catch {
    return undefined
  }
}

function resolveAgent(spec: AgentSpec): AgentBinary {
  const cached = resolved.get(spec.id)
  if (cached) return cached

  // Resolution order:
  //   1. Explicit env override: TURING_ACP_<ID>_BIN=/path/to/bin (exec'd directly)
  //   2. Bundled npm dep (dist JS file) — run via the current runtime
  //   3. Direct binary on PATH — wrapper script, exec'd directly
  //   4. Fallback: `npx -y <pkg>` (slow, network-bound)
  const envKey = `TURING_ACP_${spec.id.replace(/-/g, "_").toUpperCase()}_BIN`
  const envOverride = process.env[envKey]

  let resolved_: AgentBinary
  if (envOverride) {
    resolved_ = agentBinary(spec, envOverride, [])
  } else {
    const bundled = resolveBundledBin(spec.npmPackage, spec.directBinaryName)
    if (bundled) {
      // Bundled bin is a plain JS entry — run it with the current runtime.
      resolved_ = agentBinary(spec, process.execPath, [bundled])
    } else {
      const onPath = which(spec.directBinaryName)
      if (onPath) {
        resolved_ = agentBinary(spec, onPath, [])
      } else {
        resolved_ = agentBinary(spec, "npx", ["-y", spec.npmPackage])
      }
    }
  }

  resolved.set(spec.id, resolved_)
  return resolved_
}

function agentBinary(spec: AgentSpec, command: string, args: string[]): AgentBinary {
  const env: Record<string, string> = {}
  for (const provider of spec.envProviders ?? []) {
    Object.assign(env, provider())
  }
  return {
    id: spec.id,
    label: spec.label,
    command,
    args,
    env: Object.keys(env).length > 0 ? env : undefined,
    authCheckCommand: spec.authCheckCommand,
    authHint: spec.authHint,
  }
}

/**
 * Public registry map. Compatibility with the original shape but with
 * dynamic binary resolution — direct binary preferred over npx.
 */
export const AGENT_REGISTRY: Record<string, AgentBinary> = new Proxy({} as Record<string, AgentBinary>, {
  get(_target, prop) {
    if (typeof prop !== "string") return undefined
    const spec = SPECS[prop]
    return spec ? resolveAgent(spec) : undefined
  },
  ownKeys() {
    return Object.keys(SPECS)
  },
  getOwnPropertyDescriptor(_t, key) {
    if (typeof key !== "string" || !SPECS[key]) return undefined
    return { enumerable: true, configurable: true, value: resolveAgent(SPECS[key]) }
  },
})

export function getAgent(id: string): AgentBinary {
  const spec = SPECS[id]
  if (!spec) {
    throw new Error(`Unknown ACP agent: ${id}. Registered: ${Object.keys(SPECS).join(", ")}`)
  }
  return resolveAgent(spec)
}

export function listAgents(): AgentBinary[] {
  return Object.keys(SPECS).map((id) => resolveAgent(SPECS[id]))
}

/** For tests: force re-detection on next getAgent call. */
export function clearAgentResolutionCache(): void {
  resolved.clear()
}
