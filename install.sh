#!/bin/sh
#
# turing-cli installer (POSIX sh)
# Detects OS/arch and installs the latest pre-built binary to ~/.local/bin/turing.
#
# Usage:
#   curl -fsSL https://github.com/WesleyIsr4/turing-cli/releases/latest/download/install.sh | sh
#
# Environment overrides:
#   TURING_VERSION  install a specific version (e.g. v0.1.0). Defaults to latest.
#   TURING_PREFIX   install directory. Defaults to $HOME/.local/bin.
#

set -eu

REPO="WesleyIsr4/turing-cli"
PREFIX="${TURING_PREFIX:-$HOME/.local/bin}"
VERSION="${TURING_VERSION:-latest}"

err() { printf "error: %s\n" "$*" >&2; exit 1; }
info() { printf "==> %s\n" "$*"; }

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v unzip >/dev/null 2>&1 || err "unzip is required"

uname_os() {
  case "$(uname -s)" in
    Linux*)  printf "linux" ;;
    Darwin*) printf "darwin" ;;
    *)       err "unsupported OS: $(uname -s) (use the Windows binary from the GitHub Release)" ;;
  esac
}

uname_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf "x64" ;;
    arm64|aarch64) printf "arm64" ;;
    *) err "unsupported architecture: $(uname -m)" ;;
  esac
}

OS="$(uname_os)"
ARCH="$(uname_arch)"
ASSET="turing-${OS}-${ARCH}.zip"

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

info "Detected: ${OS}/${ARCH}"
info "Downloading ${URL}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL -o "$TMP/$ASSET" "$URL"; then
  err "download failed — does the release ${VERSION} exist for ${OS}/${ARCH}? See https://github.com/${REPO}/releases"
fi

info "Extracting"
unzip -q "$TMP/$ASSET" -d "$TMP"

# The build script outputs dist/<target>/bin/turing inside the zip.
BIN="$(find "$TMP" -type f -name turing | head -n 1)"
[ -n "$BIN" ] || err "binary not found in archive"

mkdir -p "$PREFIX"
install -m 0755 "$BIN" "$PREFIX/turing"

info "Installed at $PREFIX/turing"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) printf "\nNote: %s is not in your PATH. Add this to your shell rc:\n  export PATH=\"%s:\$PATH\"\n" "$PREFIX" "$PREFIX" ;;
esac

printf "\nRun: turing --help\n"
