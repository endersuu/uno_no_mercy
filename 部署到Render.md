# 部署到 Render

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

## 免费实例与房间

免费实例的休眠、额度和可用性以 Render 当前政策为准。首次访问休眠实例可能需要等待唤醒。

房间保存在单个 Node 进程的内存中。实例重启、休眠或重新部署会清空房间；一分钟重连只适用于服务器仍在运行时的玩家断线。不要配置多实例或自动扩容。Render 如果为此服务开启自动部署，后续推送 `main` 可能触发重启；可在服务设置中选择手动部署，避开正在进行的游戏。

## 排错

- 缺少 `vite` / `tsc`：确认构建命令包含 `npm ci --include=dev`。
- 找不到 `dist/server.js`：先确认构建步骤成功执行了 `npm run build`。
- 页面能打开但无法联机：确认创建的是 Web Service，并且双方使用同一个 HTTPS 服务地址。
- 部署失败：查看 Render 的构建或运行日志。不要把 API Key、密码或完整凭据贴到聊天中。
