import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"

/**
 * Memory store for agent-written user profile + project memory, inspired by
 * hermes-agent's `tools/memory_tool.py`. Copied patterns:
 *   - Two bounded text files (§-delimited entries)
 *   - Character limits (not token) so behavior is model-independent
 *   - Threat scanner rejects prompt injection / exfil patterns
 *   - Substring-based replace/remove (LLM-friendly, no IDs)
 *
 * Our additions over hermes:
 *   - `writtenAt` timestamp per entry → enables decay-aware eviction
 *   - `agent_context` filter on writes → subagents/cron cannot poison the
 *     primary store
 */

export const ENTRY_DELIMITER = "\n§\n"

export interface Limits {
  memoryChars: number
  userChars: number
  perEntryChars: number
}

export const DEFAULT_LIMITS: Limits = {
  memoryChars: 4000,
  userChars: 2000,
  perEntryChars: 500,
}

export type Target = "memory" | "user"
export type AgentContext = "primary" | "subagent" | "cron"

export interface WriteOptions {
  agentContext?: AgentContext
}

export interface StoreLocations {
  userPath: string
  memoryPath: string
}

export interface Entry {
  content: string
  writtenAt: string // ISO
}

/**
 * Per-turing-workspace memory store. `userPath` is shared across all
 * workspaces on the machine (so cross-project preferences persist); `memoryPath`
 * is scoped to the current workspace/project.
 */
export class MemoryStore {
  readonly userPath: string
  readonly memoryPath: string
  readonly limits: Limits

  constructor(loc: StoreLocations, limits: Limits = DEFAULT_LIMITS) {
    this.userPath = loc.userPath
    this.memoryPath = loc.memoryPath
    this.limits = limits
    ensureDir(this.userPath)
    ensureDir(this.memoryPath)
  }

  listEntries(target: Target): Entry[] {
    const raw = this.#read(target)
    if (!raw) return []
    return parseEntries(raw)
  }

  asText(target: Target): string {
    return this.#read(target)
  }

  /** Render both stores as a single context-block-ready string. */
  snapshot(): string {
    const user = this.asText("user").trim()
    const mem = this.asText("memory").trim()
    const parts: string[] = []
    if (user) {
      parts.push(formatSection("USER preferences", user, this.userBytes(), this.limits.userChars))
    }
    if (mem) {
      parts.push(formatSection("WORKSPACE memory", mem, this.memBytes(), this.limits.memoryChars))
    }
    return parts.join("\n\n").trim()
  }

  add(target: Target, content: string, opts: WriteOptions = {}): WriteResult {
    const ctx = opts.agentContext ?? "primary"
    if (ctx !== "primary") return { ok: false, reason: "blocked: non-primary context" }
    const clean = content.trim()
    if (!clean) return { ok: false, reason: "empty content" }
    if (clean.length > this.limits.perEntryChars) {
      return { ok: false, reason: `entry exceeds per-entry limit (${this.limits.perEntryChars} chars)` }
    }
    const threat = scanThreats(clean)
    if (threat) return { ok: false, reason: `rejected: ${threat}` }

    const entry: Entry = { content: clean, writtenAt: new Date().toISOString() }
    const existing = this.listEntries(target)

    // Dedupe: if an entry with identical content exists, refresh timestamp and move to bottom.
    const filtered = existing.filter((e) => e.content !== clean)
    filtered.push(entry)

    const serialized = serializeEntries(filtered)
    const limit = target === "user" ? this.limits.userChars : this.limits.memoryChars
    if (serialized.length > limit) {
      // Evict oldest by writtenAt until it fits
      const sorted = [...filtered].sort((a, b) => a.writtenAt.localeCompare(b.writtenAt))
      while (serializeEntries(sorted).length > limit && sorted.length > 1) {
        sorted.shift()
      }
      this.#write(target, serializeEntries(sorted))
      return { ok: true, evictedCount: filtered.length - sorted.length }
    }
    this.#write(target, serialized)
    return { ok: true, evictedCount: 0 }
  }

  replace(
    target: Target,
    oldSubstring: string,
    newContent: string,
    opts: WriteOptions = {},
  ): WriteResult {
    const ctx = opts.agentContext ?? "primary"
    if (ctx !== "primary") return { ok: false, reason: "blocked: non-primary context" }
    const entries = this.listEntries(target)
    const idx = entries.findIndex((e) => e.content.includes(oldSubstring))
    if (idx < 0) return { ok: false, reason: "no entry matched the substring" }
    const threat = scanThreats(newContent)
    if (threat) return { ok: false, reason: `rejected: ${threat}` }
    entries[idx] = {
      content: newContent.trim(),
      writtenAt: new Date().toISOString(),
    }
    const serialized = serializeEntries(entries)
    const limit = target === "user" ? this.limits.userChars : this.limits.memoryChars
    if (serialized.length > limit) {
      return { ok: false, reason: `replacement would exceed store limit (${limit} chars)` }
    }
    this.#write(target, serialized)
    return { ok: true, evictedCount: 0 }
  }

  remove(target: Target, substring: string, opts: WriteOptions = {}): WriteResult {
    const ctx = opts.agentContext ?? "primary"
    if (ctx !== "primary") return { ok: false, reason: "blocked: non-primary context" }
    const entries = this.listEntries(target)
    const before = entries.length
    const filtered = entries.filter((e) => !e.content.includes(substring))
    if (filtered.length === before) return { ok: false, reason: "no entry matched the substring" }
    this.#write(target, serializeEntries(filtered))
    return { ok: true, evictedCount: before - filtered.length }
  }

  userBytes(): number {
    return this.asText("user").length
  }

  memBytes(): number {
    return this.asText("memory").length
  }

  #read(target: Target): string {
    const path = target === "user" ? this.userPath : this.memoryPath
    if (!existsSync(path)) return ""
    try {
      return readFileSync(path, "utf8")
    } catch {
      return ""
    }
  }

  #write(target: Target, text: string): void {
    const path = target === "user" ? this.userPath : this.memoryPath
    ensureDir(path)
    writeFileSync(path, text.trim(), "utf8")
  }
}

export interface WriteResult {
  ok: boolean
  reason?: string
  evictedCount?: number
}

// ---------- helpers ----------

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function parseEntries(raw: string): Entry[] {
  const body = raw.trim()
  if (!body) return []
  return body.split(ENTRY_DELIMITER).map((chunk) => {
    // Entries may optionally carry a leading metadata line `<!-- writtenAt: ISO -->`.
    const match = /^<!--\s*writtenAt:\s*([^\s]+)\s*-->\n?/.exec(chunk)
    if (match) {
      return { content: chunk.slice(match[0].length).trim(), writtenAt: match[1] }
    }
    return { content: chunk.trim(), writtenAt: "1970-01-01T00:00:00.000Z" }
  })
}

function serializeEntries(entries: Entry[]): string {
  return entries
    .map((e) => `<!-- writtenAt: ${e.writtenAt} -->\n${e.content}`)
    .join(ENTRY_DELIMITER)
}

function formatSection(title: string, body: string, used: number, limit: number): string {
  const pct = Math.round((used / limit) * 100)
  const header = `${title} [${pct}% — ${used}/${limit} chars]`
  const underline = "─".repeat(Math.min(header.length, 60))
  return `${header}\n${underline}\n${stripMetadata(body)}`
}

function stripMetadata(body: string): string {
  return body.replace(/^<!--\s*writtenAt:[^\n]*-->\n?/gm, "").trim()
}

// ---------- threat scanner ----------

const THREAT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /ignore\s+(?:all\s+)?previous\s+instructions?/i, label: "prompt-override" },
  { pattern: /disregard\s+(?:all\s+)?prior\s+instructions?/i, label: "prompt-override" },
  { pattern: /you\s+are\s+now\s+(?:a\s+)?[^.]*jailbroken/i, label: "jailbreak" },
  { pattern: /reveal\s+(?:the\s+)?system\s+prompt/i, label: "system-prompt-exfil" },
  { pattern: /curl\s+[^|]*\$(?:API_KEY|OPENAI_|ANTHROPIC_|TOKEN|SECRET)/i, label: "key-exfil" },
  { pattern: /wget\s+[^|]*\$(?:API_KEY|OPENAI_|ANTHROPIC_|TOKEN|SECRET)/i, label: "key-exfil" },
  { pattern: /cat\s+[^|]*\/\.env\b/i, label: "env-exfil" },
  { pattern: /cat\s+[^|]*\/\.netrc\b/i, label: "netrc-exfil" },
  { pattern: /cat\s+[^|]*\/\.pgpass\b/i, label: "pgpass-exfil" },
  { pattern: />>\s*~\/?\.ssh\/authorized_keys/i, label: "authorized-keys-write" },
  { pattern: /[​‌‍‮﻿]/, label: "invisible-unicode" },
]

/** Returns a label string if the content looks hostile, otherwise undefined. */
export function scanThreats(content: string): string | undefined {
  for (const { pattern, label } of THREAT_PATTERNS) {
    if (pattern.test(content)) return label
  }
  return undefined
}
