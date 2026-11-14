# 部署到 Render

本项目已部署到 **https://uno-no-mercy-8skm.onrender.com**，使用 Free Web Service、Node.js 24 和单实例。无需再创建服务即可直接玩。以下说明也适用于自行部署副本。

[打开一键部署入口](https://render.com/deploy?repo=https://github.com/endersuu/uno_no_mercy)

仓库中的 `render.yaml` 已配置 Node.js 24、Free Web Service、构建和启动命令，以及 `/health` 健康检查。不需要数据库、游戏密钥或自己购买域名。

## 首次部署

1. 打开上面的部署入口，登录 Render（可以使用 GitHub 登录）。
2. 按页面提示授权 Render 读取 `endersuu/uno_no_mercy` 仓库。如果仓库是私有的，确保授权范围包含它。
3. 选择工作区，确认服务方案是 **Free**，再提交部署。若控制台没有免费方案，请先停止，不要改成付费实例。
4. 等待构建完成并显示 **Live**。服务页面会给出一个 HTTPS `*.onrender.com` 地址，具体地址以平台实际分配结果为准。
5. 用该公网地址进入游戏，创建房间后复制邀请链接。朋友不需要安装 Node.js，也不必与你连接同一个 Wi-Fi。

这是部署入口，不是已经运行的游戏地址。提交仓库配置不会自动在一个尚未授权的 Render 账户里创建服务。

## 如果使用手动创建服务

选择 **Web Service**（不要选 Static Site），连接仓库并填写：

| 设置                    | 值                                      |
| ----------------------- | --------------------------------------- |
| Branch                  | `main`                                  |
| Runtime                 | `Node`                                  |
| Build Command           | `npm ci --include=dev && npm run build` |
| Start Command           | `npm start`                             |
| Instance Type           | `Free`                                  |
| Health Check Path       | `/health`                               |
| 环境变量 `NODE_VERSION` | `24`                                    |
| 环境变量 `NODE_ENV`     | `production`                            |

不要将端口写死为 3000；程序会读取 Render 注入的 `PORT` 并监听 `0.0.0.0`。前端与 Socket.IO 共用同一服务，平台 HTTPS 地址同时支持实时连接。

## 上线后检查

- 打开平台分配的游戏地址，首页应正常显示。
- 在该地址后加 `/health` 应返回 `{"ok":true}`。
- 用两个独立浏览器或设备创建、加入同一个房间，确认双方都收到手牌并能出牌。
- 在一方打开游戏规则后，双方应暂停；关闭规则后由暂停发起者点击「继续游戏」。

## GitHub Actions 与自动部署

工作流位于 `.github/workflows/ci.yml`。推送 `main`、向 `main` 提交 PR 或在 Actions 页面手动运行，都会执行：

1. 安装锁定的依赖，使用 Node.js 24 构建并检查 TypeScript。
2. 运行游戏规则、房间生命周期等单元测试。
3. 安装与 Playwright 版本匹配的 Chromium，运行全部浏览器回归测试。
4. 保存浏览器报告、截图与失败追踪，保留 7 天。

公开 GitHub 仓库使用本工作流的标准 Linux 执行器免费。失败时在 [Actions 页面](https://github.com/endersuu/uno_no_mercy/actions/workflows/ci.yml) 打开对应运行，查看错误或下载 `browser-results` 附件。

Render 的 **Auto-Deploy** 应选择 **After CI Checks Pass**，对应 `render.yaml` 中的 `autoDeployTrigger: checksPass`。服务追踪 `main`，GitHub 检查通过后才发布；失败不发布，PR 不发布。无需在 GitHub 添加 Render API Key。

Render 原生自动部署要求连接 GitHub：在 Render 的 **Account Settings → Git Deployment Credentials** 授权仓库，并确认服务的仓库连接使用该凭证。仅填写公开 Git URL 创建的服务不支持原生自动部署，即使显示了仓库地址也不代表已连接。检查已绿但没有部署事件时，先检查该连接。详见 [Render 自动部署](https://render.com/docs/deploys) 与 [GitHub 连接说明](https://render.com/docs/github)。

若服务的 **Git Credentials** 已显示你的邮箱，而 **Use My Credentials** 按钮置灰，不要仅凭按钮状态判断授权缺失。打开 [Render 的 GitHub 应用设置](https://github.com/apps/render/installations/new)，确认 **Repository access** 中包含 `endersuu/uno_no_mercy`；使用 **Only select repositories** 并只选择这个仓库即可。授权设置确认后，用一次新的提交验证：先在 GitHub Actions 看到该提交检查成功，再到 Render 的 Deploys / Events 确认同一提交由自动事件部署；只有 CI 变绿不能证明自动部署已经接通。

自动部署会重启游戏进程并清空旧房间。开发时使用分支和 PR 验证，准备上线再合并到 `main`。

## 免费实例与房间

免费实例的休眠、额度和可用性以 Render 当前政策为准。首次访问休眠实例可能需要等待唤醒。

房间保存在单个 Node 进程的内存中。实例重启、休眠或重新部署会清空房间；5 分钟重连只适用于服务器仍在运行时的玩家断线。不要配置多实例或自动扩容。Render 如果为此服务开启自动部署，后续推送 `main` 可能触发重启；可在服务设置中选择手动部署，避开正在进行的游戏。

## 公网防刷与 DDoS 边界

应用已加入共享限流，重新连接不能重置计数。超过 HTTP 限额返回 `429` 和 `Retry-After`；超过消息频率或连接数量时拒绝或关闭连接。

| 项目                                       | 全服务上限      | 启用访客 IP 识别后的单 IP 上限 |
| ------------------------------------------ | --------------- | ------------------------------ |
| HTTP 请求（含 Socket.IO 握手与轮询）       | 1200 次 / 60 秒 | 300 次 / 60 秒                 |
| 新建实时连接                               | 240 次 / 60 秒  | 120 次 / 60 秒                 |
| 同时存在的实时连接                         | 256             | 32                             |
| 实时消息包（包含未知事件、未带回执的消息） | 2000 次 / 10 秒 | 400 次 / 10 秒                 |
| 创建房间                                   | 120 次 / 60 秒  | 30 次 / 60 秒                  |

另有 512 条 TCP 连接上限、每连接 80 个消息包 / 10 秒、8 KiB 消息大小、1000 个房间上限，以及未加入房间的连接超时清理。计数采用固定时间窗口，缓存最多 4096 项并定期清理；正常对局和手动暂停不会因闲置被踢出。健康检查 `/health` 不受请求频率限制，以免限流导致平台误判实例故障。

默认不信任 `X-Forwarded-For`。本机直连按 TCP 对端 IP 限流；在 Render（`RENDER=true`）上，未核实反向代理链时只启用全局和单连接限制，避免把所有玩家当成同一个代理 IP。确认平台追加请求头的方式及可信代理跳数后，才设置 `TRUST_PROXY_HOPS`（1–8）；不要盲目设为 1，也不要直接取可伪造的最左侧 IP。代理配置错误会导致绕过限流或误伤玩家。

这些措施控制应用的资源消耗，不能保证遭受分布式攻击时仍可访问。Render [官方说明](https://render.com/docs/ddos-protection)表示所有应用自动获得 Cloudflare DDoS 防护，[FAQ](https://render.com/docs/faq)说明不收取 DDoS 攻击产生的带宽费用。当前服务仍为 Free；绑卡后普通出站流量和构建额度超额可能收费，应结合账号用量和告警查看，不能把 Free 理解为账单硬上限。尚未调整账号级预算或告警配置。

## 排错

- 缺少 `vite` / `tsc`：确认构建命令包含 `npm ci --include=dev`。
- 找不到 `dist/server.js`：先确认构建步骤成功执行了 `npm run build`。
- 页面能打开但无法联机：确认创建的是 Web Service，并且双方使用同一个 HTTPS 服务地址。
- 部署失败：查看 Render 的构建或运行日志。不要把 API Key、密码或完整凭据贴到聊天中。
