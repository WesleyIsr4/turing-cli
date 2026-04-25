import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { openStoreForWorkspace, type Target } from "@/memory"

export const MemoryCommand = cmd({
  command: "memory",
  describe: "inspect and edit the agent's persistent memory",
  builder: (yargs: Argv) =>
    yargs
      .command(MemoryListCommand)
      .command(MemoryAddCommand)
      .command(MemoryRemoveCommand)
      .command(MemoryClearCommand)
      .command(MemoryPathCommand)
      .demandCommand(),
  async handler() {},
})

function targetOpt() {
  return {
    describe: "which store to act on",
    type: "string" as const,
    choices: ["user", "memory"],
    default: "memory",
  }
}

export const MemoryListCommand = cmd({
  command: "list",
  describe: "show current memory contents",
  builder: (yargs: Argv) => yargs.option("target", targetOpt()).option("workspace", workspaceOpt()),
  handler: (args) => {
    const store = openStoreForWorkspace(resolveWorkspace(args as any))
    const target = (args as any).target as Target
    const entries = store.listEntries(target)
    if (entries.length === 0) {
      UI.println(UI.Style.TEXT_DIM + `(no ${target} entries yet)` + UI.Style.TEXT_NORMAL)
      return
    }
    const total = target === "user" ? store.userBytes() : store.memBytes()
    const limit = target === "user" ? store.limits.userChars : store.limits.memoryChars
    UI.println(
      UI.Style.TEXT_HIGHLIGHT_BOLD +
        `${target.toUpperCase()} · ${entries.length} entries · ${total}/${limit} chars` +
        UI.Style.TEXT_NORMAL,
    )
    for (const [i, e] of entries.entries()) {
      const date = e.writtenAt.slice(0, 10)
      UI.println(`${UI.Style.TEXT_DIM}[${i + 1}] ${date}${UI.Style.TEXT_NORMAL}  ${e.content}`)
    }
  },
})

export const MemoryAddCommand = cmd({
  command: "add <content..>",
  describe: "append a new entry to the store",
  builder: (yargs: Argv) =>
    yargs
      .positional("content", { type: "string", array: true, demandOption: true })
      .option("target", targetOpt())
      .option("workspace", workspaceOpt()),
  handler: (args) => {
    const content = ((args as any).content as string[]).join(" ")
    const store = openStoreForWorkspace(resolveWorkspace(args as any))
    const target = (args as any).target as Target
    const r = store.add(target, content)
    if (!r.ok) {
      UI.error(`failed to add: ${r.reason}`)
      process.exit(1)
    }
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `added to ${target}` + UI.Style.TEXT_NORMAL)
    if (r.evictedCount && r.evictedCount > 0) {
      UI.println(UI.Style.TEXT_DIM + `(evicted ${r.evictedCount} oldest entries to fit)` + UI.Style.TEXT_NORMAL)
    }
  },
})

export const MemoryRemoveCommand = cmd({
  command: "remove <substring..>",
  describe: "remove all entries containing a substring",
  builder: (yargs: Argv) =>
    yargs
      .positional("substring", { type: "string", array: true, demandOption: true })
      .option("target", targetOpt())
      .option("workspace", workspaceOpt()),
  handler: (args) => {
    const substring = ((args as any).substring as string[]).join(" ")
    const store = openStoreForWorkspace(resolveWorkspace(args as any))
    const target = (args as any).target as Target
    const r = store.remove(target, substring)
    if (!r.ok) {
      UI.error(r.reason ?? "nothing removed")
      process.exit(1)
    }
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD + `removed ${r.evictedCount} entries from ${target}` + UI.Style.TEXT_NORMAL,
    )
  },
})

export const MemoryClearCommand = cmd({
  command: "clear",
  describe: "remove ALL entries from a store (irreversible)",
  builder: (yargs: Argv) =>
    yargs
      .option("target", targetOpt())
      .option("workspace", workspaceOpt())
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false }),
  handler: async (args) => {
    const target = (args as any).target as Target
    if (!(args as any).yes) {
      UI.error("Re-run with --yes to confirm clearing the " + target + " store.")
      process.exit(2)
    }
    const store = openStoreForWorkspace(resolveWorkspace(args as any))
    const entries = store.listEntries(target)
    if (entries.length === 0) {
      UI.println(`${target} already empty`)
      return
    }
    // Substring match on empty doesn't work; we remove each individually by
    // using the first N chars.
    for (const e of entries) {
      store.remove(target, e.content)
    }
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD + `cleared ${entries.length} entries from ${target}` + UI.Style.TEXT_NORMAL,
    )
  },
})

export const MemoryPathCommand = cmd({
  command: "path",
  describe: "print the on-disk paths of the memory files",
  builder: (yargs: Argv) => yargs.option("workspace", workspaceOpt()),
  handler: (args) => {
    const store = openStoreForWorkspace(resolveWorkspace(args as any))
    UI.println(`user:    ${store.userPath}`)
    UI.println(`memory:  ${store.memoryPath}`)
  },
})

function workspaceOpt() {
  return {
    describe: "workspace dir to key the MEMORY.md store against (defaults to cwd)",
    type: "string" as const,
    default: process.cwd(),
  }
}

function resolveWorkspace(args: { workspace?: string }): string {
  return args.workspace ?? process.cwd()
}
