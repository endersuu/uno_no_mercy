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

## 查看与汇总用户统计日志

部署本版本后，在服务的 **Logs** 中搜索 `uno-analytics`，即可看到连接、加入房间、实际对局及断线的 JSON 日志。`device_id` 是站内随机浏览器标识的摘要，`identity_scope=persistent` 时刷新、重连和切换 VPN 不会变；它不需要新增 Render 密钥或数据库。统计日志不写入昵称、重连凭证、手牌或完整引荐 URL。

重点看这些字段：

| 字段                             | 含义                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `event=visitor_connected`        | 网页建立了实时连接，可能尚未参加游戏                    |
| `event=player_active`            | 该浏览器实际进入对局，可按 `device_id` 去重估算玩家数   |
| `source` / `medium` / `campaign` | 入口链接的 UTM 推广标签                                 |
| `referrer`                       | 浏览器提供的引荐域名；直接访问或隐藏来源时可能为空      |
| `browser` / `os` / `device_type` | 浏览器、操作系统及设备类别                              |
| `language` / `timezone`          | 浏览器设置，仅作粗略分布参考                            |
| `network_ip`                     | 按可信代理规则获取的网络出口地址，VPN 下通常是 VPN 出口 |

Render 默认未验证代理链，因此 `network_ip` 为 `null`。只有确认平台请求头追加规则和可信跳数后，才配置 `TRUST_PROXY_HOPS`；不要为了统计随意信任 `X-Forwarded-For`。浏览器设备标识用于跨 IP 去重，不能获取 IMEI、MAC 或绕过 VPN 识别真实位置。没有可靠地理信息时保持未知，不把语言、时区当作国家或城市。

将所需时间段的日志导出/保存到本地后，在项目目录安装依赖并汇总：

```sh
npm ci
npm run --silent analytics:report -- /tmp/uno.log > /tmp/uno-report.json
```

也可传多个文件或从标准输入读取。报告包含全部输入范围的独立访客、实际玩家、房间参与者、连接数、局数，以及 UTC 每日和来源/浏览器/系统/语言/时区分布；同一浏览器重连不会增加去重人数。`persistent`、`ephemeral`、`connection` 分组帮助识别存储受限或旧客户端造成的统计偏差。精确口径和推广链接示例见 [README](README.md#访客设备与来源统计)。

日志保留时长受 Render 当前方案与设置影响；应用本身不会永久保存原始日志，重启也不会补回丢失记录。长期趋势可使用下方 Turso 配置，仍可定期导出并妥善保管原始日志，不要将带设备标识和网络地址的原始日志公开发布。环境变量 `ANALYTICS_ENABLED=false` 可关闭统计记录，正常联机不受影响。

## 配置 Turso 长期统计

Render 日志用于查看近期事件，Turso 保存跨部署、重启的长期访客与玩家统计。游戏服务继续使用 Render Free；不要把生产统计写入 Render 本地 SQLite，免费实例的文件系统会在重启、部署或休眠后丢失，且不支持持久盘。[Render 官方说明](https://render.com/docs/free)

Turso 当前 Free 方案提供 5GB 存储、每月 5 亿行读取和 1000 万行写入，无需信用卡；具体额度以创建时的 [官方定价](https://turso.tech/pricing) 为准。以下操作只使用 Free，不需要开启付费方案或超额计费。

1. 注册或登录 [Turso 控制台](https://app.turso.tech/)，选择 **Free**，创建一个统计专用数据库，区域尽量接近 Render 服务。
2. 在该数据库中复制 **Database URL**，并创建该数据库的访问 Token。服务端需要写入及首次建表权限；不使用管理整个组织的 API Token。保留控制台给出的 URL 格式（`libsql://` 或 `turso://` 等），不要自行替换数据库域名。
3. 打开现有 Render 服务的 **Environment**，添加 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN`，确保 `ANALYTICS_ENABLED=true`。Token 只填入环境变量，不提交到仓库或发到聊天中。环境变量变更需部署/重启才能生效，会清空当前内存房间，应避开正在进行的游戏。
4. 部署后在 **Logs** 搜索 `uno-analytics-storage`，确认数据库状态为 `ready`；用两个浏览器参加一次对局，等待约 5 秒，再用下方命令确认 `players` 已增加。若出现 `config_error`，检查两个变量是否齐全和 URL 格式；`retry` 表示写入暂时失败，检查 Token 权限、网络及 Turso 用量；`overflow` 表示待写队列已满，部分统计可能遗漏。错误日志不输出 Token 或完整连接信息。

设置两个环境变量本身不代表数据库已成功连通，需要 `ready` 状态和真实查询结果验证。未配置数据库时仍只输出 Render 日志，联机正常；目前没有自动导入接入前的历史日志。

本机查询长期统计：

```sh
npm ci
# 先在本机环境中配置数据库 URL 和 Token；查询可单独使用只读 Token。
npm run --silent analytics:db-report
npm run --silent analytics:db-report -- --from 2026-11-01 --to 2026-11-30 > /tmp/uno-monthly.json
```

也可将本机凭据保存到未提交的 `.env`，通过 `node --env-file=.env --import tsx scripts/analytics-db-report.ts` 读取。查询工具只读已有表，不会自动建表；首次接入应先让服务端初始化成功。

数据库按「UTC 日期＋匿名设备标识＋来源组合」聚合，不保存网络 IP、昵称、重连凭证、房间/局 ID 或手牌。报告跨日期、来源按设备标识去重，包含访客、实际玩家、房间参与者和各类别分布；数据库不保存连接次数和局数，相关统计需使用原始日志报告。语言、时区仍只是客户端设置，不代表真实所在地。

程序不按天删除数据库历史，但数据持续保留仍取决于数据库存在、服务条款与用量额度，建议定期备份。异步队列每 5 秒尝试批量写入，失败会重试，游戏不等待数据库；队列只在内存中，停机期间断网、进程被强制终止或队列溢出可能丢失未写入记录。Render 原始日志在保留期内可用于核对，目前没有自动回填。

## 排错

- 缺少 `vite` / `tsc`：确认构建命令包含 `npm ci --include=dev`。
- 找不到 `dist/server.js`：先确认构建步骤成功执行了 `npm run build`。
- 页面能打开但无法联机：确认创建的是 Web Service，并且双方使用同一个 HTTPS 服务地址。
- 部署失败：查看 Render 的构建或运行日志。不要把 API Key、密码或完整凭据贴到聊天中。
