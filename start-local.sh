#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1 && node -e 'var p=process.versions.node.split(".");process.exit(Number(p[0])>22||(Number(p[0])===22&&Number(p[1])>=12)?0:1)' >/dev/null 2>&1; then
  exec node scripts/start-local.mjs
fi
if command -v mise >/dev/null 2>&1; then
  echo '当前 Node.js 不满足要求，正在使用 mise 的 Node.js 24…'
  exec mise exec node@24 -- node scripts/start-local.mjs
fi
echo '需要 Node.js 22.12 或更新版本。推荐用 mise 安装并运行：' >&2
echo '  mise install node@24' >&2
echo '  mise exec node@24 -- sh start-local.sh' >&2
echo '也可以从 https://nodejs.org 安装 Node.js LTS，然后重新打开终端。' >&2
exit 1
