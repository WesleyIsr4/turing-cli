import { Log } from "@/util"
import {
  ClientSideConnection,
  ndJsonStream,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import type { ACPAgentProcess } from "./subprocess"
import type { Client } from "@agentclientprotocol/sdk"

const log = Log.create({ service: "acp-client-connection" })

export interface ConnectionOptions {
  process: ACPAgentProcess
  clientHandler: Client
  protocolVersion?: number
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
  }
}

export interface SessionPromptStream {
  /**
   * Iterates session/update notifications for this prompt turn as they arrive.
   * Ends when the agent returns the final prompt response.
   */
  updates(): AsyncIterable<SessionNotification>
  /** Resolves with the final PromptResponse (stopReason, etc). */
  result: Promise<PromptResponse>
}

/**
 * High-level client-side ACP connection. Wraps the SDK's ClientSideConnection
 * and adds ergonomic helpers for turing (session management, prompt streaming).
 *
 * Lifecycle:
 *   1. `new ACPConnection({ process, clientHandler })`
 *   2. `await conn.initialize()` — handshake
 *   3. `await conn.newSession(cwd, mcpServers)` — get a sessionId
 *   4. `conn.prompt(sessionId, content)` — returns stream of updates + final result
 *   5. `await conn.close()` — shutdown the subprocess
 */
export class ACPConnection {
  readonly process: ACPAgentProcess
  readonly clientHandler: Client
  #inner: ClientSideConnection
  #initResponse: InitializeResponse | undefined
  #updateRouter = new SessionUpdateRouter()
  #protocolVersion: number
  #clientCapabilities: ConnectionOptions["clientCapabilities"]

  constructor(opts: ConnectionOptions) {
    this.process = opts.process
    this.#protocolVersion = opts.protocolVersion ?? 1
    this.#clientCapabilities = opts.clientCapabilities ?? {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    }

    const router = this.#updateRouter
    const originalHandler = opts.clientHandler
    this.clientHandler = {
      ...originalHandler,
      async sessionUpdate(params) {
        router.dispatch(params)
        await originalHandler.sessionUpdate(params)
      },
    }

    const stream = ndJsonStream(opts.process.stdin, opts.process.stdout)
    this.#inner = new ClientSideConnection(() => this.clientHandler, stream)
  }

  get closed(): Promise<void> {
    return this.#inner.closed
  }

  get initResponse(): InitializeResponse | undefined {
    return this.#initResponse
  }

  async initialize(): Promise<InitializeResponse> {
    const resp = await this.#inner.initialize({
      protocolVersion: this.#protocolVersion,
      clientCapabilities: {
        fs: {
          readTextFile: this.#clientCapabilities?.fs?.readTextFile ?? true,
          writeTextFile: this.#clientCapabilities?.fs?.writeTextFile ?? true,
        },
        terminal: this.#clientCapabilities?.terminal ?? false,
      },
    })
    this.#initResponse = resp
    log.info("initialized", {
      protocolVersion: resp.protocolVersion,
      agent: resp.agentInfo?.name,
      version: resp.agentInfo?.version,
    })
    return resp
  }

  async newSession(params: {
    cwd: string
    mcpServers?: McpServer[]
  }): Promise<NewSessionResponse> {
    const resp = await this.#inner.newSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    })
    log.info("session created", { sessionId: resp.sessionId })
    return resp
  }

  /**
   * Sends a prompt and returns a stream of updates + final result.
   * Caller should iterate updates() and await result.
   */
  prompt(sessionId: string, content: ContentBlock[]): SessionPromptStream {
    const queue = this.#updateRouter.subscribe(sessionId)
    const result = this.#inner
      .prompt({ sessionId, prompt: content })
      .then((resp) => {
        queue.finish()
        return resp
      })
      .catch((err) => {
        queue.finish(err)
        throw err
      })
    return {
      updates: () => queue.iterable(),
      result,
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#inner.cancel({ sessionId })
  }

  /** Change the active mode (e.g. "default", "plan", "acceptEdits"). */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#inner.setSessionMode({ sessionId, modeId })
  }

  /** Change the model variant (e.g. "default", "sonnet", "haiku"). UNSTABLE in ACP. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.#inner.unstable_setSessionModel({ sessionId, modelId })
  }

  async close(): Promise<void> {
    await this.process.shutdown()
    this.#updateRouter.closeAll()
  }
}

/**
 * Routes incoming sessionUpdate notifications to per-session async queues.
 * Enables `connection.prompt()` to return a stream that corresponds only to
 * the updates for that sessionId.
 */
class SessionUpdateRouter {
  #queues = new Map<string, UpdateQueue>()

  subscribe(sessionId: string): UpdateQueue {
    const existing = this.#queues.get(sessionId)
    if (existing && !existing.done) return existing
    const q = new UpdateQueue()
    this.#queues.set(sessionId, q)
    return q
  }

  dispatch(notification: SessionNotification) {
    const q = this.#queues.get(notification.sessionId)
    if (q && !q.done) q.push(notification)
  }

  closeAll() {
    for (const q of this.#queues.values()) q.finish()
    this.#queues.clear()
  }
}

class UpdateQueue {
  #buffer: SessionNotification[] = []
  #waiters: Array<(v: IteratorResult<SessionNotification>) => void> = []
  #done = false
  #error: unknown

  get done() {
    return this.#done
  }

  push(item: SessionNotification) {
    if (this.#done) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ value: item, done: false })
    } else {
      this.#buffer.push(item)
    }
  }

  finish(error?: unknown) {
    if (this.#done) return
    this.#done = true
    this.#error = error
    while (this.#waiters.length) {
      const w = this.#waiters.shift()!
      if (error) w(Promise.reject(error) as never)
      else w({ value: undefined, done: true })
    }
  }

  iterable(): AsyncIterable<SessionNotification> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (self.#buffer.length) {
              return Promise.resolve({ value: self.#buffer.shift()!, done: false as const })
            }
            if (self.#done) {
              if (self.#error) return Promise.reject(self.#error)
              return Promise.resolve({ value: undefined, done: true as const })
            }
            return new Promise<IteratorResult<SessionNotification>>((resolve) => {
              self.#waiters.push(resolve)
            })
          },
        }
      },
    }
  }
}
