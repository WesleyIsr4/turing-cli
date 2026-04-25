import type { Plugin, PluginInput } from "@turing-ai/plugin"
import type { Model as V2Model } from "@turing-ai/sdk/v2"
import {
  acpCommands,
  acpSessionPool,
  checkAgentAuth,
  getAgent,
  spawnACPAgent,
  ACPConnection,
  createClientHandler,
} from "@/acp-client"
import { Log } from "@/util"

const log = Log.create({ service: "plugin.claude-code" })

/**
 * Warms the agent binary by briefly spawning it, running initialize, and
 * terminating. This primes npm/npx cache + warms up the claude CLI, cutting
 * the first-real-prompt latency from ~15s to ~3-5s.
 *
 * Runs in the background; failures are swallowed (non-fatal).
 */
async function warmUpAgent(): Promise<void> {
  try {
    const agent = getAgent("claude-code")
    const auth = await checkAgentAuth(agent)
    if (!auth.ok) {
      log.debug("skipping warm-up: not authenticated", { message: auth.message })
      return
    }
    const proc = spawnACPAgent(agent)
    const conn = new ACPConnection({
      process: proc,
      clientHandler: createClientHandler({
        onSessionUpdate: () => {},
      }),
    })
    try {
      await conn.initialize()
      log.info("warm-up done")
    } finally {
      await conn.close().catch(() => {})
    }
  } catch (err) {
    log.debug("warm-up failed", { error: String(err) })
  }
}

/**
 * Registers "claude-code" as a provider in turing. Actual streaming is
 * handled by the ACP client pipeline (see packages/turing/src/acp-client/).
 *
 * Models map 1:1 to the variants Claude Code exposes:
 *   - `default`  — Opus 4.7 (1M context), most capable
 *   - `sonnet`   — Sonnet 4.6, everyday tasks
 *   - `sonnet[1m]` — Sonnet 4.6 with 1M context
 *   - `haiku`    — Haiku 4.5, fastest
 *
 * Selecting a model in turing (e.g. via `Ctrl+X M` or `/models`) is
 * translated to an ACP `session/set_model` call by the LLM bypass so Claude
 * Code picks up the chosen variant on the next turn.
 *
 * Auth is delegated to the local `claude` CLI — users must run
 * `claude auth login` once. Failure surfaces at session start.
 */
export const ClaudeCodePlugin: Plugin = async (_input: PluginInput) => {
  // Fire off warm-up in the background; don't block plugin init.
  if (process.env.TURING_CLAUDE_CODE_SKIP_WARMUP !== "1") {
    void warmUpAgent()
  }
  return {
    async event({ event }) {
      // Release pooled ACP subprocess + cached commands when an turing
      // session is deleted.
      if (event?.type === "session.deleted") {
        const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
        if (sessionID) {
          acpCommands.clear(sessionID)
          await acpSessionPool.release("claude-code", sessionID)
        }
      }
    },
    provider: {
      id: "claude-code",
      async models(): Promise<Record<string, V2Model>> {
        const out: Record<string, V2Model> = {}
        for (const variant of CLAUDE_CODE_VARIANTS) {
          out[variant.id] = buildModel(variant)
        }
        return out
      },
    },
  }
}

interface VariantSpec {
  id: string
  name: string
  context: number
  output: number
}

export const CLAUDE_CODE_VARIANTS: VariantSpec[] = [
  { id: "default", name: "Claude Code · Default (Opus 4.7, 1M)", context: 1_000_000, output: 64000 },
  { id: "sonnet", name: "Claude Code · Sonnet 4.6", context: 200_000, output: 64000 },
  { id: "sonnet[1m]", name: "Claude Code · Sonnet 4.6 (1M)", context: 1_000_000, output: 64000 },
  { id: "haiku", name: "Claude Code · Haiku 4.5", context: 200_000, output: 8192 },
]

function buildModel(v: VariantSpec): V2Model {
  return {
    id: v.id,
    providerID: "claude-code",
    name: v.name,
    api: {
      id: `claude-code/${v.id}`,
      npm: "@agentclientprotocol/claude-agent-acp",
      url: "",
    },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: { context: v.context, output: v.output },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-04-01",
  }
}

/**
 * Lightweight pre-flight check: verifies `claude auth status` succeeds.
 */
export async function ensureClaudeCodeAuth(): Promise<{ ok: boolean; message?: string }> {
  return checkAgentAuth(getAgent("claude-code"))
}

export default ClaudeCodePlugin
