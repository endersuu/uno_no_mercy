import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`当前 Node.js ${process.versions.node}，需要 22.12 或更新版本。`);
  console.error('可以执行 mise install node@24，然后执行 mise exec node@24 -- node scripts/start-local.mjs。');
  console.error('也可以从 https://nodejs.org 安装 Node.js LTS，再重新打开终端。');
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须是 1–65535 之间的整数。');
  process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  const result = spawnSync(npm, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    console.error('启动准备失败，请查看上方错误。首次运行需要联网下载依赖。');
    process.exit(result.status || 1);
  }
}
if (!existsSync('node_modules/.package-lock.json')) {
  console.log('首次启动：正在安装依赖，请稍候…');
  run(['ci', '--include=dev', '--no-audit', '--no-fund']);
}
console.log('正在构建游戏…');
run(['run', 'build']);
const child = spawn(process.execPath, [resolve('dist/server.js')], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
  stdio: ['inherit', 'pipe', 'inherit'],
});
let ready = false;
child.stdout.on('data', (data) => {
  process.stdout.write(data);
  if (ready || !data.toString().includes('UNO server listening on port')) return;
  ready = true;
  const url = `http://localhost:${port}`;
  console.log(`\n游戏已启动！本机打开：${url}`);
  console.log('请保持此窗口开启。按 Ctrl+C 停止游戏。');
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`同一 Wi-Fi / 局域网的朋友可访问：http://${address.address}:${port}`);
      }
    }
  }
  console.log('邀请朋友时，请先用上述局域网地址进入游戏，再创建房间并复制邀请链接。\n');
  if (process.env.UNO_NO_OPEN === '1') return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const opener = spawn(command, args, { stdio: 'ignore', detached: true });
  opener.on('error', () => console.log(`浏览器未自动打开，请手动输入：${url}`));
  opener.unref();
});
child.on('error', (error) => {
  console.error('服务未能启动：', error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  if (!ready) console.error('游戏启动失败。如果提示 EADDRINUSE，请先关闭已占用该端口的程序。');
  process.exitCode = code || 0;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
