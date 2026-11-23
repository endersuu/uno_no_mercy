# UNO · No Mercy 双人朋友局

TypeScript 实时双人 MVP。创建房间后复制链接，第二位玩家加入即开始。游戏无需账号或数据库，不包含积分或排名；可选连接 Turso 保存长期运营统计。

在线游戏：**https://uno-no-mercy-8skm.onrender.com**。创建房间后将邀请链接发给朋友即可，电脑和手机都可直接进入。

## 公网部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/endersuu/uno_no_mercy)

已提供 `render.yaml`，使用 Node.js 24 和 Free Web Service。点击上方按钮，登录 Render 并授权仓库后即可提交部署；平台会分配 HTTPS `*.onrender.com` 子域名。免费方案是否可用以控制台为准。详见 [部署到 Render](部署到Render.md)。配置已就绪不代表服务已上线，实际网址需要部署完成后由平台分配。

## CI 与自动部署

[GitHub Actions](https://github.com/endersuu/uno_no_mercy/actions/workflows/ci.yml) 会在推送 `main`、向 `main` 提交 PR 或手动运行时，使用 Node.js 24 执行构建、单元测试和全部 Chromium 浏览器测试。测试报告、截图及失败时的操作追踪保留 7 天。

Render 使用 `autoDeployTrigger: checksPass`，连接 GitHub 仓库后，只有 `main` 的检查通过才自动部署；PR 只运行测试。此流程不需要在 GitHub 保存 Render API Key。首次连接与排错见 [部署说明](部署到Render.md#github-actions-与自动部署)。

## 启动

要求 Node.js 22.12+（本环境验证为 Node 24）。

使用 mise 时，项目的 `mise.toml` 选择 Node.js 24。在项目目录执行：

```sh
mise install node@24
mise exec node@24 -- node scripts/start-local.mjs
```

若提示配置未信任，检查 `mise.toml` 后执行 `mise trust ./mise.toml`。`start-local.sh` / `start-local.cmd` 在系统 Node 缺失或过旧时也会尝试使用 PATH 中的 mise。

已安装合适版本 Node 时，开发模式：

```sh
npm ci
npm run dev
```

开发服务器监听 `0.0.0.0:3000`，Vite 和 Socket.IO 共用一个端口。可以用 `PORT` 修改端口。生产模式：

```sh
npm run build
npm start
```

邀请链接使用当前页面的域名。两名玩家必须能访问同一服务器地址；远程朋友可直接使用上面的 Render 公网地址。自行部署时，反向代理需支持 WebSocket 升级和长轮询。只启动一个进程：房间存放在内存，不支持多实例，也不会在服务器重启后恢复。

## 已实现

- 168 张牌、每人 7 张、服务端安全洗牌及出牌判定。
- 同色 / 同数字 / 同图案出牌，抽到可出为止；+2 / +4 / +6 / +10 按不低于上一张数值叠加。
- 双人跳过 / 反转 / 跳过所有人、同色全弃、7 换手、0 传手、颜色轮盘、25 张淘汰。
- UNO 宣告和抓漏喊、双方确认再开一局。
- 首页、候房间、游戏内中文规则。游戏内看规则会同步暂停；仅暂停发起者可恢复。
- 主动离开立即结束；断线暂停，5 分钟内用原浏览器标签页重连恢复手牌。空房销毁，断线席位到期释放。
- 普通对局视图只发送自己的手牌；玩家主动导出调试记录时会取得双方完整状态。第三人无法加入，席位由随机重连凭证保护；昵称按纯文本显示。
- 随窗口高度适应的一屏对局界面，宽屏左右 / 竖屏上下排布；手机竖屏缩小完整牌面并同时展示全部手牌，不翻页，短屏只滚动手牌区。电脑及手机横屏多牌时保留分组翻页；支持键盘操作与原生模态框。
- 首张牌移出并翻面；双方出牌飞入弃牌堆、抽牌飞入手牌；跳过、换手与同色全弃有独立动效和文字提示；新入手牌有「新牌」标记。
- 翻牌、双方出牌、跳过、换手、抽牌、回合、UNO、质疑和胜负音效；首次点击后可播放，右上角可静音并记住设置，规则弹窗内可试听。
- 显眼的双方回合横条和手牌区标签，可出牌及可用按钮高亮，禁用操作明显变暗。
- 经典 UNO 样式的原创矢量牌面：黑色边框、白色斜椭圆、鲜明四色、角标数字。
- 「本局动态」保留最近 12 条公开操作，出牌以卡牌缩略图搭配当时的结算效果展示；普通抽牌只显示数量。牌桌保留罚抽累计和回合提示。操作等待服务器确认后才展示结果；展示期间禁止重复出牌。
- 暂停、断线、离开及切后台会取消旧动效并同步最新状态；遵循系统「减少动态效果」偏好。

已提供请求、消息和建房共享限流、连接数上限、闲置连接清理及消息大小限制。Render 上的访客 IP 识别需要先验证代理配置；应用限流无法替代平台 DDoS 防护。具体上限及边界见 [部署说明](部署到Render.md#公网防刷与-ddos-边界)。

最新本机运行包为 **0.6.0 手机竖屏优化版**。先关闭旧版游戏窗口，再将新版解压到新文件夹，按 `本机开始游戏.md` 启动。

## 已确认的规则调整

No Mercy 官方规则没有质疑机制，且双人万能反转 +4 原本会罚自己抽牌。本项目按用户确认的约定，让所有 +4 罚对手抽牌，并允许质疑：

1. 出 +4 前，出牌者若另有当前颜色且当时可出的牌，则质疑成功，最后这张 +4 的出牌者承担全部累计罚抽；质疑者抽 0 张，并继续回合。叠加时，替代牌也必须满足叠加要求，例如接 +4 时同色数字牌或 +2 不算。整笔罚抽清零，不再保留此前的叠加。
2. 质疑失败，质疑者抽累计罚抽量 +2 张，跳过回合。
3. 例如累计罚抽为 12 张，A 质疑 B 最后叠上的 +4：成功时 A 抽 0 张、B 抽 12 张；失败时 A 抽 14 张。两种结算都会清空累计罚抽。
4. 叠加或接受罚抽视为放弃本次质疑；服务器只返回判定结果，不暴露对手手牌。
5. 最后一张打出即获胜，行动牌不再结算。全弃自动弃掉全部同色牌；有可出牌时不能主动抽牌。

完整可读规则位于 `src/client/rules.ts`。游戏内「游戏规则 → 每张牌的意思」提供 13 类牌的图文说明，另附 `卡牌说明.md` 供离线阅读。牌组包含每色 0–9 各两张、跳过 / 反转 / +2 / 全弃各三张、+4 / 跳过所有人各两张；另有万能反转 +4 八张、+6 四张、+10 四张、颜色轮盘八张。

## 导出对局调试记录

展开牌桌底部「本局动态」，选择局数后点击「导出对局记录（JSON）」。进行中可导出截至当前的记录；结束后可导出整局，再来一局后仍可选择上一局。记录在房间存续期间保留，离开房间或服务器重启前请下载保存。

JSON 包含双方昵称、初始洗牌结果、双方完整手牌、牌堆和弃牌堆，以及每次操作前后的完整状态。出牌 ID、选定颜色、UNO 选择、质疑结果、累计罚抽、暂停/继续、断线/重连、离开及被服务器拒绝的游戏操作均按顺序记录，不受界面最近 12 条动态的限制。正常游戏视图不携带这些私有数据；只有房间内玩家主动导出时才返回记录，文件不含重连凭证或连接标识。

- `schemaVersion` 标记文件格式；`server.commit` 和 `server.rulesVersion` 标记运行版本。
- `round` 标记局号、开始/结束时间和记录条数；`exportedAt` 是导出时间。
- `initialDeck` 是发牌前的洗牌结果，`initialDeckTop: "last"` 表示从数组末尾抽牌。
- `entries` 按 `sequence` 排列；初始记录为 `start`，其 `after.game` 包含发牌后的状态。后续记录用 `actor` 标记玩家 0/1，`action` 标记操作，`before` / `after` 可对照手牌、牌堆、颜色、回合与罚抽变化。拒绝操作同时记录 `error` 和请求的 `requestedRevision`。
- `current` 是导出局的最后状态。`complete` 表示从开局到该状态的记录是否完整；局是否结束看 `round.finishedAt`。若记录写入失败，文件会标记不完整并提供 `recordingError`，不影响正常游戏。

服务端使用私有临时目录中的逐行记录文件，避免把整局历史反复发给客户端或一直积存在内存。房间销毁后清理记录；本功能不是跨重启的永久历史存储。

## 访客、设备与来源统计

服务端默认向标准输出写入逐行 JSON 日志，搜索 `"kind":"uno-analytics"` 即可查看。四类事件分别是连接页面 `visitor_connected`、成功创建/加入房间 `room_entered`、进入实际对局 `player_active`、断开连接 `visitor_disconnected`。单次连接的同一局每天只记一次活跃；跨 UTC 日期后，下一次未暂停且双方在线的对局状态更新会补记当天活跃。它表示参与了对局，不保证玩家主动出过牌；没有状态更新时也不会产生每日心跳。

`device_id` 是浏览器随机 UUID 的 SHA-256 摘要。原 UUID 保存在当前站点的 localStorage，不使用 IP 去重，因此切换网络或 VPN 后，同一浏览器仍可识别。它不是 IMEI、MAC 或硬件指纹，也不代表一个自然人：换浏览器、无痕窗口或清理网站数据会产生新标识，多人共用浏览器则可能合并。`identity_scope` 为 `persistent` 表示持久浏览器标识，`ephemeral` 表示存储不可用时的页面临时标识，`connection` 表示旧客户端/无有效标识的连接级回退；后两种可能高估人数。所有客户端标识及设备信息均可伪造，只用于运营估算，不能用于认证或反作弊。

日志还包含浏览器与系统类别、设备类型、语言、时区、引荐域名，以及入口 URL 的 `utm_source` / `utm_medium` / `utm_campaign`。推广链接可写为 `https://你的游戏域名/?utm_source=wechat&utm_medium=share&utm_campaign=friends`；UTM 标签只接受最长 80 字符的英文字母、数字、空格及 `_.~-`。引荐只保存域名，不记录完整来源 URL、查询参数、昵称、重连凭证或手牌。`network_ip` 使用现有可信代理规则获取；它可能是 VPN 出口，不能揭示真实位置，语言、时区也不能当作所在地。Render 未核实代理链时该字段为 `null`。

将服务器日志导出为本地文件后，在已执行 `npm ci` 的项目目录运行：

```sh
npm run analytics:report -- /tmp/uno.log
npm run --silent analytics:report -- /tmp/uno-1.log /tmp/uno-2.log > /tmp/uno-report.json
cat /tmp/uno.log | npm run --silent analytics:report
```

报告为聚合 JSON：`totals.visitors` 是日志中出现过的独立浏览器标识数，`players` 是有实际对局记录的独立标识数，`room_entrants` 是成功进入房间的独立标识数；`connections` 区分重连次数，`rounds` 对双方记录和重连去重。`daily` 按 UTC 日期统计当日有记录的访客和实际玩家；`by_source` 优先使用 UTM 来源，其次引荐域名，否则记为 `direct/unknown`；还有浏览器、系统、设备类型、语言（`by_language`）、时区（`by_timezone`）和标识持久性分组；语言和时区分组只反映客户端设置，不代表真实地理位置。同一设备可出现在多个来源或日期中，各组不能简单相加。重复导出的日志不会增加去重人数；报告只反映输入文件覆盖的记录，不推算缺失记录。`input.malformed_records` 显示不兼容或损坏的统计记录数，普通启动日志会跳过，也兼容日志行前的平台时间戳。

日志始终写入标准输出供 Render 收集，不增加公开统计接口。设置服务端环境变量 `ANALYTICS_ENABLED=false` 可关闭统计记录。Render 查看日志和代理配置见 [部署说明](部署到Render.md#查看与汇总用户统计日志)。

### 长期统计：Turso

配置 `TURSO_DATABASE_URL` 和 `TURSO_AUTH_TOKEN` 后，服务端会同时将统计异步写入 Turso。两个变量均未配置时仅输出日志；配置错误或数据库暂时不可用不会阻止联机。使用 Turso 控制台提供的数据库 URL，支持 `libsql://`、`https://` 和 `turso://`；Token 使用该数据库的访问令牌，放在 Render Environment 或本机环境变量中，不写入代码、聊天或公开日志。生产环境不允许回退到本地 SQLite，以免 Render 临时磁盘在重启后丢失数据。免费数据库创建步骤见 [部署说明](部署到Render.md#配置-turso-长期统计)。

数据库按「UTC 日期＋匿名设备标识＋来源组合」合并记录，保存首次/最后出现时间、是否进入房间、是否实际参局，以及设备和来源类别。重复上报、重连或服务器重启不会增加同一天同一来源的重复行；同一设备跨日期或来源仍用 `COUNT(DISTINCT device_id)` 统计。数据库不保存 IP、连接 ID、房间 ID、局 ID、昵称、凭证或出牌内容，因此长期数据库报告不提供连接次数和局数；这两个指标仍可从保存的原始日志计算。

在本机设置数据库环境变量后，可查询全部历史或指定 UTC 日期范围（首尾日期都包含）：

```sh
npm run --silent analytics:db-report
npm run --silent analytics:db-report -- --from 2026-11-01 --to 2026-11-30 > /tmp/uno-monthly.json
```

若凭据保存在项目根目录未提交的 `.env` 中，可用 `node --env-file=.env --import tsx scripts/analytics-db-report.ts`。查询工具只读取已有表，不创建或修改数据库，可以使用单独的只读 Token；服务端需要有写入及建表权限的数据库 Token。报告包含去重访客、实际玩家、房间参与者，以及每日、来源、浏览器、系统、设备类型、语言、时区和标识持久性分组。各组不能直接相加；浏览器类别在同一天同一来源下发生变化时，使用最后一次记录的类别。

应用没有按天自动删除数据库记录，在所选服务额度内持续保存；仍建议定期导出报告或数据库备份，并关注 Turso 用量。默认每 5 秒批量落库，内存队列有上限并对失败写入退避重试，正常停机尽力排空；断网期间被强制终止或队列溢出可能丢失尚未落库的数据。JSON 日志仍保留在 Render 的日志保留期内，但目前没有自动从日志回填数据库，不能保证数据库记录绝不遗漏。

## 验证

```sh
npm test            # 引擎和房间生命周期；含 120 局牌量守恒模拟
npm run build       # 严格 TypeScript 检查、前后端构建
npm run test:e2e    # 构建后运行；真实 Chromium 双会话及手机布局
```

浏览器测试默认使用 `/usr/bin/chromium`，其他系统可通过 `CHROMIUM_PATH` 指定 Chromium 可执行文件。测试会自行启动生产服务；本地已有 3000 端口服务时会复用。浏览器测试覆盖邀请、拒绝第三人、暂停看规则、刷新重连、完整对局、双方再战、离开销毁、移动端布局，以及出牌动效、操作锁定、中途暂停和减少动态效果。

`GET /health` 返回 `{"ok":true}`。客户端重连凭证位于 sessionStorage，清理网站数据或换设备不能恢复席位。Socket.IO 通过连接关闭或心跳超时检测断线，检测之后开始 5 分钟倒计时；切换标签页本身不主动断开连接，手机挂起页面后则可能触发心跳超时。手动暂停不延长重连期限，持续在线但未操作不会触发此倒计时。

## 代码

- `src/server/game.ts`：规则引擎，服务器独占完整牌局。
- `src/server/rooms.ts`：房间、席位、暂停、重连、再战和私有视图。
- `src/server/debug-records.ts`：按局保存完整调试记录并生成 JSON 导出。
- `src/server/index.ts`：HTTP / Socket.IO 接口、输入验证、消息限流。
- `src/server/analytics.ts`：匿名设备和来源统计事件。
- `src/server/analytics-store.ts` / `turso.ts`：异步聚合写入及数据库连接。
- `scripts/analytics-report.ts` / `analytics-db-report.ts`：原始日志和长期数据库的只读汇总工具。
- `src/shared/types.ts`：前后端共享协议。
- `src/client/`：TypeScript 界面、规则、响应式样式；`motion.ts` 负责公开事件的动效及文字反馈。

非官方同人项目，与 Mattel 无关联。使用自行绘制的 SVG / CSS 牌面，不含官方图像资源；短音效由 Web Audio 本地合成。
