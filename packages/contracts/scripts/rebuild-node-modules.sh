#!/usr/bin/env bash
# Recreate the node_modules tree on /tmp and link it into the repo.
#
# Why this exists: /home is a 300MB volume and cannot hold the ~450MB
# (unpacked) dependency tree, so node_modules lives on the root disk at
# /tmp/ar-contracts and is symlinked into packages/contracts. /tmp does NOT
# survive a reboot — after one, re-run this single script and the toolchain
# is back.
#
# Usage: bash scripts/rebuild-node-modules.sh
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${AR_TMP_DIR:-/tmp/ar-contracts}"
NPM_CACHE="${AR_NPM_CACHE:-/tmp/npm-cache}"

echo "==> clearing previous /tmp install at $TMP_DIR"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$NPM_CACHE"

echo "==> copying package definition (excl. node_modules) to $TMP_DIR"
tar -C "$PKG_DIR" --exclude=node_modules -cf - . | tar -C "$TMP_DIR" -xf -

echo "==> fresh npm install on the root disk (cache in $NPM_CACHE)"
NPM_CONFIG_CACHE="$NPM_CACHE" npm install --no-audit --no-fund --loglevel=error --prefix "$TMP_DIR"

echo "==> linking $TMP_DIR/node_modules into the repo"
rm -rf "$PKG_DIR/node_modules"
ln -s "$TMP_DIR/node_modules" "$PKG_DIR/node_modules"

echo "==> verifying toolchain"
"$PKG_DIR/node_modules/.bin/hardhat" --version
echo "Done: node_modules -> $TMP_DIR/node_modules"
