# turing-cli

AI-powered development tool for the terminal. CLI built on top of [Claude Code](https://claude.ai/code) via the Agent Client Protocol (ACP), with a built-in catalog of specialist agents (Review, QA, Docs, etc.) curated by Trinca.

> Status: **early preview (`v0.1.0`)**. APIs, agents, and packaging may change.

---

## Install

### One-line install (Linux, macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/WesleyIsr4/turing-cli/main/install.sh | sh
```

This downloads the latest pre-built binary for your OS/architecture from GitHub Releases and installs it at `~/.local/bin/turing`. Make sure `~/.local/bin` is in your `PATH`.

### Manual install

Download the binary for your platform from the [latest release](https://github.com/WesleyIsr4/turing-cli/releases/latest), extract it, and put it somewhere on your `PATH`.

Supported targets:

| OS      | Architecture                                       |
|---------|----------------------------------------------------|
| Linux   | `x64`, `arm64` (glibc and musl, baseline variants) |
| macOS   | `x64`, `arm64` (Apple Silicon)                     |
| Windows | `x64`, `arm64`                                     |

### Build from source

Requires [Bun](https://bun.sh) `1.3.13+`.

```sh
git clone https://github.com/WesleyIsr4/turing-cli.git
cd turing-cli
bun install
bun run --cwd packages/turing build --single   # builds the binary for the current platform
./packages/turing/dist/*/bin/turing            # run it
```

For local development without compiling:

```sh
bun run dev
```

---

## Usage

```sh
turing             # open the interactive TUI in the current directory
turing --help      # list commands and flags
```

The CLI looks for a `.turing/turing.jsonc` file in the project directory for permissions, MCP servers, and overrides. Without one, it works with sensible defaults.

### Authenticating

`turing` uses Claude Code as its model provider. Sign in once with the Claude Code CLI (`claude login`) and the token is reused.

---

## Built-in agents

Specialist agents shipped with the binary:

- **review** — read-only critical reviewer. Reads the diff and reports MUST-FIX vs NICE-TO-HAVE findings against the user story's acceptance criteria.
- *(more coming — see roadmap)*

Agents live in `packages/turing/src/agent/trinca/` and are bundled into the binary at build time.

---

## Project structure

```
packages/
├── turing/     CLI core, TUI, agents, build script
├── sdk/        TypeScript/Go SDKs
├── plugin/     Plugin runtime
├── shared/     Shared utilities
└── script/     Build helpers
```

---

## Contributing

Bug reports and feature requests via [GitHub Issues](https://github.com/WesleyIsr4/turing-cli/issues). Pull requests welcome — please open an issue first to discuss non-trivial changes.

---

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Trinca.
