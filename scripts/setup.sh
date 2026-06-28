#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> CursorRemote setup"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js 20+ is required. Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found $(node -v))"
  exit 1
fi

echo "==> Installing dependencies"
npm install

echo "==> Creating data directories"
mkdir -p data temp

if [ ! -f .env ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
else
  echo "==> .env already exists (skipped)"
fi

echo
echo "Setup complete."
echo
echo "Next steps:"
echo "  1. Launch Cursor with CDP enabled:"
echo "       cursor --remote-debugging-port=9222"
echo "  2. Start the relay server:"
echo "       npm run dev"
echo "  3. Open the web client:"
echo "       http://localhost:3000"
echo
echo "Optional — build and install the VS Code extension:"
echo "       npm run build:ext"
echo "       cursor --install-extension releases/cursor-remote-*.vsix"
