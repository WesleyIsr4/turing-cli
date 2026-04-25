import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import { MemoryStore, type Limits } from "./memory-store"

/**
 * Resolve per-workspace MemoryStore locations.
 *
 * USER.md is machine-global (shared across all workspaces/projects) so
 * cross-project preferences persist. MEMORY.md is keyed by a hash of the
 * absolute workspace path so symlink / profile tricks don't leak project
 * memories between unrelated directories.
 */
export function resolveMemoryLocations(workspaceDir: string): {
  userPath: string
  memoryPath: string
} {
  const base = join(homedir(), ".config", "turing", "memory")
  const userPath = join(base, "USER.md")
  const keyed = workspaceKey(workspaceDir)
  const memoryPath = join(base, "workspaces", `${keyed}.md`)
  return { userPath, memoryPath }
}

function workspaceKey(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16)
}

export function openStoreForWorkspace(workspaceDir: string, limits?: Limits): MemoryStore {
  return new MemoryStore(resolveMemoryLocations(workspaceDir), limits)
}
