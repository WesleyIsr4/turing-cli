import { Log } from "@/util"
import { ACPConnection } from "./connection"
import { createClientHandler, type PermissionResolver } from "./handler"
import type { SessionUpdateHandler } from "./handler"
import { spawnACPAgent } from "./subprocess"
import { checkAgentAuth, type AuthCheckResult } from "./auth"
import { getAgent, type AgentBinary } from "./registry"
import type { McpServer } from "@agentclientprotocol/sdk"

const log = Log.create({ service: "acp-client-pool" })

export interface AvailableMode {
  id: string
  name?: string
  description?: string
}

export interface AvailableModel {
  modelId: string
  name?: string
  description?: string
}

export interface PoolEntry {
  connection: ACPConnection
  acpSessionId: string
  lastUsedAt: number
  agent: AgentBinary
  updateHandler: SessionUpdateHandler
  permissionResolver: PermissionResolver | undefined
  availableModes: AvailableMode[]
  availableModels: AvailableModel[]
  currentModeId: string | undefined
  currentModelId: string | undefined
  /**
   * Memory snapshot captured at session acquire time. Frozen for the life of
   * the pool entry so the prompt cache prefix stays byte-identical. Mid-session
   * memory writes persist to disk but do NOT refresh this snapshot — they take
   * effect next time `acquire` spawns a fresh entry.
   */
  memorySnapshot: string
  /** Set to true after the first turn has consumed the memory snapshot. */
  memorySnapshotConsumed: boolean
}

export interface PoolAcquireOptions {
  agentId: string
  turingSessionId: string
  cwd: string
  mcpServers?: McpServer[]
  onSessionUpdate: SessionUpdateHandler
  resolvePermission?: PermissionResolver
  /**
   * Optional memory snapshot (USER.md + MEMORY.md block, pre-fenced).
   * Captured at acquire time and stored on the entry — callers prefix
   * this to user messages when they are the first in a session turn.
   */
  memorySnapshot?: string
}

/**
 * Keyed by `${agentId}:${turingSessionId}`, the pool caches one ACP
 * subprocess + session per turing session so successive turns skip the
 * ~2-3s cold-start and retain Claude Code's in-memory context.
 *
 * Evicted when:
 *   - the subprocess dies (natural death)
 *   - `release(sessionId)` is called (turing session ended)
 *   - `closeAll()` is called (shutdown)
 *
 * NOT evicted by idle TTL: Claude Code sessions are cheap to leave running,
 * and the token/context is on-disk via claude CLI anyway. If a pool explosion
 * becomes an issue, add TTL here.
 */
export class ACPSessionPool {
  #entries = new Map<string, PoolEntry>()
  #pending = new Map<string, Promise<{ ok: true; entry: PoolEntry } | (AuthCheckResult & { ok: false })>>()

  /**
   * Get the existing entry for this turing session if still alive, otherwise
   * spawn + initialize + newSession and cache the entry. The provided update
   * handler and permission resolver are captured per-entry (not per-acquire).
   *
   * Concurrent calls for the same key share a single in-flight acquire
   * (`#pending`) so we never spawn duplicate subprocesses when the caller
   * pipeline races us — this used to leak ghost ACP processes whose
   * permission rulesets stayed alive but were unreferenced.
   *
   * If the agent failed auth pre-flight, returns `{ ok: false, message }`.
   */
  async acquire(
    opts: PoolAcquireOptions,
  ): Promise<{ ok: true; entry: PoolEntry } | (AuthCheckResult & { ok: false })> {
    const key = this.#key(opts.agentId, opts.turingSessionId)
    const existing = this.#entries.get(key)
    if (existing && !this.#procExited(existing)) {
      existing.lastUsedAt = Date.now()
      existing.updateHandler = opts.onSessionUpdate
      existing.permissionResolver = opts.resolvePermission
      return { ok: true, entry: existing }
    }
    if (existing) {
      this.#entries.delete(key)
    }

    const inflight = this.#pending.get(key)
    if (inflight) return inflight

    const promise = this.#spawnEntry(opts, key)
    this.#pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.#pending.delete(key)
    }
  }

  async #spawnEntry(
    opts: PoolAcquireOptions,
    key: string,
  ): Promise<{ ok: true; entry: PoolEntry } | (AuthCheckResult & { ok: false })> {
    const agent = getAgent(opts.agentId)

    const auth = await checkAgentAuth(agent)
    if (!auth.ok) return { ok: false, message: auth.message }

    const proc = spawnACPAgent(agent)
    let entry: PoolEntry

    const handler = createClientHandler({
      onSessionUpdate: (params) => entry?.updateHandler?.(params),
      resolvePermission: (req) =>
        (entry?.permissionResolver ?? autoAllowFallback)(req),
    })

    const connection = new ACPConnection({
      process: proc,
      clientHandler: handler,
    })

    try {
      await connection.initialize()
      const session = await connection.newSession({
        cwd: opts.cwd,
        mcpServers: opts.mcpServers ?? [],
      })

      const modesState = (session as { modes?: unknown }).modes as
        | { availableModes?: Array<{ id: string; name?: string; description?: string | null }>; currentModeId?: string }
        | undefined
      const modelsState = (session as { models?: unknown }).models as
        | {
            availableModels?: Array<{ modelId: string; name?: string; description?: string | null }>
            currentModelId?: string
          }
        | undefined

      entry = {
        connection,
        acpSessionId: session.sessionId,
        lastUsedAt: Date.now(),
        agent,
        updateHandler: opts.onSessionUpdate,
        permissionResolver: opts.resolvePermission,
        availableModes:
          modesState?.availableModes?.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description ?? undefined,
          })) ?? [],
        availableModels:
          modelsState?.availableModels?.map((m) => ({
            modelId: m.modelId,
            name: m.name,
            description: m.description ?? undefined,
          })) ?? [],
        currentModeId: modesState?.currentModeId,
        currentModelId: modelsState?.currentModelId,
        memorySnapshot: opts.memorySnapshot ?? "",
        memorySnapshotConsumed: false,
      }
      this.#entries.set(key, entry)

      // When the subprocess dies, auto-evict.
      void connection.process.exited.then(() => {
        const current = this.#entries.get(key)
        if (current === entry) this.#entries.delete(key)
        log.info("pool entry evicted (process exit)", {
          key,
          pid: connection.process.pid,
        })
      })

      log.info("pool entry created", {
        key,
        acpSessionId: session.sessionId,
        pid: proc.pid,
      })
      return { ok: true, entry }
    } catch (err) {
      log.error("pool acquire failed", { key, error: String(err) })
      await connection.close().catch(() => {})
      throw err
    }
  }

  /**
   * Rebinds the captured update handler + permission resolver on an existing
   * entry. Used by the LLM bypass between turns — each turn has its own
   * generator that needs to collect events for that turn only.
   */
  bindHandlers(
    entry: PoolEntry,
    onSessionUpdate: SessionUpdateHandler,
    resolvePermission?: PermissionResolver,
  ) {
    entry.updateHandler = onSessionUpdate
    entry.permissionResolver = resolvePermission
    entry.lastUsedAt = Date.now()
  }

  /** Explicit release — shuts down the subprocess and removes from pool. */
  async release(agentId: string, turingSessionId: string): Promise<void> {
    const key = this.#key(agentId, turingSessionId)
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    await entry.connection.close().catch(() => {})
    log.info("pool entry released", { key })
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    await Promise.all(entries.map((e) => e.connection.close().catch(() => {})))
    log.info("pool closed", { count: entries.length })
  }

  size(): number {
    return this.#entries.size
  }

  /** For inspection/testing only. */
  has(agentId: string, turingSessionId: string): boolean {
    return this.#entries.has(this.#key(agentId, turingSessionId))
  }

  /** Returns undefined if no pooled entry exists for this session. */
  getEntry(agentId: string, turingSessionId: string): PoolEntry | undefined {
    return this.#entries.get(this.#key(agentId, turingSessionId))
  }

  /**
   * Switch the active mode on the pooled session (e.g. "plan", "acceptEdits").
   * No-op if no entry exists.
   */
  async setMode(agentId: string, turingSessionId: string, modeId: string): Promise<void> {
    const entry = this.getEntry(agentId, turingSessionId)
    if (!entry) return
    await entry.connection.setMode(entry.acpSessionId, modeId)
    entry.currentModeId = modeId
  }

  /**
   * Switch the active model variant (e.g. "sonnet", "haiku", "default").
   * No-op if no entry exists.
   */
  async setModel(agentId: string, turingSessionId: string, modelId: string): Promise<void> {
    const entry = this.getEntry(agentId, turingSessionId)
    if (!entry) return
    await entry.connection.setModel(entry.acpSessionId, modelId)
    entry.currentModelId = modelId
  }

  #key(agentId: string, sessionId: string): string {
    return `${agentId}:${sessionId}`
  }

  #procExited(entry: PoolEntry): boolean {
    const proc = entry.connection.process as unknown as { exitCode?: number | null }
    return typeof proc.exitCode === "number" && proc.exitCode !== null
  }
}

const autoAllowFallback: PermissionResolver = async (req) => {
  const allow = req.options.find((o) => o.kind === "allow_always" || o.kind === "allow_once")
  if (allow) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } }
  }
  return { outcome: { outcome: "cancelled" } }
}

/**
 * Singleton pool for the current turing process. Callers should not
 * instantiate their own pool.
 */
export const acpSessionPool = new ACPSessionPool()

if (typeof process !== "undefined" && typeof process.on === "function") {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void acpSessionPool.closeAll()
    })
  }
}
