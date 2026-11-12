#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先从 https://nodejs.org 安装 Node.js LTS，再运行本脚本。'
  exit 1
fi
exec node scripts/start-local.mjs
