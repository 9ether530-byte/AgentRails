#!/usr/bin/env bash
# Recreate the node_modules trees on /tmp and link them into the repo.
#
# Why this exists: /home is a 300MB volume and cannot hold the dependency
# trees (~450MB unpacked for contracts, ~350MB for service), so node_modules
# lives on the root disk — /tmp/ar-contracts and /tmp/ar-service — and is
# symlinked into each package. /tmp does NOT survive a reboot; after one,
# re-run this single script and the whole toolchain (both packages) is back.
#
# The service package reads the contracts build artifacts at runtime, so the
# script also compiles the contracts if artifacts/ are missing (artifacts are
# gitignored).
#
# Usage: bash scripts/rebuild-node-modules.sh
set -euo pipefail

CONTRACTS_PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_PKG="$(cd "$CONTRACTS_PKG/.." && pwd)/service"
NPM_CACHE="${AR_NPM_CACHE:-/tmp/npm-cache}"

build_tree() {
  local PKG_DIR="$1" TMP_DIR="$2"
  echo "==> clearing previous /tmp install at $TMP_DIR"
  rm -rf "$TMP_DIR"
  mkdir -p "$TMP_DIR" "$NPM_CACHE"
  echo "==> copying $(basename "$PKG_DIR") package definition (excl. node_modules/data) to $TMP_DIR"
  tar -C "$PKG_DIR" --exclude=node_modules --exclude=data -cf - . | tar -C "$TMP_DIR" -xf -
  echo "==> fresh npm install on the root disk (cache in $NPM_CACHE)"
  NPM_CONFIG_CACHE="$NPM_CACHE" npm install --no-audit --no-fund --loglevel=error --prefix "$TMP_DIR"
  echo "==> linking $TMP_DIR/node_modules into the repo"
  rm -rf "$PKG_DIR/node_modules"
  ln -s "$TMP_DIR/node_modules" "$PKG_DIR/node_modules"
}

build_tree "$CONTRACTS_PKG" "${AR_TMP_DIR:-/tmp/ar-contracts}"
build_tree "$SERVICE_PKG" "${AR_SERVICE_TMP_DIR:-/tmp/ar-service}"

echo "==> verifying toolchain"
"$CONTRACTS_PKG/node_modules/.bin/hardhat" --version
"$SERVICE_PKG/node_modules/.bin/hardhat" --version
"$SERVICE_PKG/node_modules/.bin/tsc" --version

if [ ! -f "$CONTRACTS_PKG/artifacts/contracts/Escrow.sol/Escrow.json" ]; then
  echo "==> contracts artifacts missing (gitignored) — compiling so the service can read them"
  (cd "$CONTRACTS_PKG" && NPM_CONFIG_CACHE="$NPM_CACHE" npx hardhat compile)
fi

echo "Done: contracts/node_modules -> /tmp/ar-contracts/node_modules, service/node_modules -> /tmp/ar-service/node_modules"
