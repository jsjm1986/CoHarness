# Agent Note: Admin-managed public access tunnel on Cloudflare Tunnel

Status: implemented

[English](2026-10-18-admin-managed-public-access-tunnel.md) | 中文

## Problem

此前把网关暴露给团队需要手工执行 `cloudflared login`、`cloudflared tunnel create`、编辑 DNS 记录、编写 ingress YAML、再配 launchd/systemd 常驻——部署文档列了这条路径，但没有管理员能在控制台里完成。新管理员往往不知道这个选项存在；网关自身也没有公网访问面。

## Decision

网关在部署页托管隧道生命周期。`harness.tunnel_access` 表按 `(organization_id, node_id)` 存一行：模式（`off`/`quick`/`named`）、期望与观测状态、公网 URL、hostname 与解析出的 zone 域、zone/account/tunnel 标识、两列 AES-256-GCM 密文（`api_token_cipher`、`run_token_cipher`，由专用属主专属密钥文件 `HGW_TUNNEL_CREDENTIAL_KEY_FILE` 加密）、最近错误、单调递增的 revision。[tunnel-access.ts](../../../../gateway/src/tunnel-access.ts) 把所有 start/stop/clear 串行进一条 promise 队列，使管理员点击、重启恢复与子进程意外退出不会交错；[tunnel-supervisor.ts](../../../../gateway/src/tunnel-supervisor.ts) 负责 `cloudflared` 二进制解析（env 覆盖 → 受管 state 目录 → PATH/常见路径）、缺失时按固定版本逐平台 SHA-256 校验下载安装、并通过 `spawn` 的 close 事件跟踪每个子进程；[cloudflare-api.ts](../../../../gateway/src/cloudflare-api.ts) 是 named 模式所需 account/zone/tunnel/ingress/DNS 调用的窄 REST 客户端；[tunnel-access-service.ts](../../../../gateway/src/postgres/tunnel-access-service.ts) 是持久化与加解密接缝。

三条管理路由——`GET /admin/api/tunnel`、`POST /admin/api/tunnel/install`、`POST /admin/api/tunnel/actions`——暴露查看、安装二进制、`start-quick`、`start-named`、`stop`、`clear`，每个动作以 `admin.tunnel.*` 记审计。Quick 模式 spawn `cloudflared tunnel --url <本机网关>` 并从 stderr 解析临时 `*.trycloudflare.com` 地址。Named 模式首次要求 Cloudflare API token，解析 account 与 zone、创建隧道、安装 token 凭证、发布 `hostname → <tunnel>.cfargotunnel.com` DNS，再通过显式 `TUNNEL_TOKEN` 环境启动 cloudflared；此后启动复用已存 run token，API token 可弃。改用不同 hostname 会先删除旧隧道与 DNS 记录再重新开通，不留孤儿资源。hostname 必须落在声明的 zone 域之下；隧道只指向网关自身的回环监听。期望状态随网关重启经 `resume()` 恢复（监听器就绪后），`shutdown()` 停止子进程；凭证密钥文件加入 systemd 不可见路径，运行时实例读不到。

生命周期、输出排空、停止失败后的句柄保留，以及持久化令牌获取遵守[隧道生命周期决策](../bug-fix/2026-10-25-gateway-tunnel-lifecycle.zh.md)。

管理区域会在浏览器启动请求待完成、服务端正在启动或清理结果不确定时提供停止操作。停止和清除接管此前动作的展示所有权；旧动作迟到的响应不能替换其状态或反馈。读取按当前动作代次排序，不能覆盖已完成的修改。读取失败显示重试入口，成功轮询保留动作失败信息。主机名和域草稿只初始化一次，主动清空后保持为空；确认保存固定域名后清除提交的 API token。剪贴板写入成功后才提示复制成功，剪贴板不可用或拒绝写入时显示可执行的错误提示。

## Alternatives considered

**只补文档指引。** 部署文档本就列了 Cloudflare Tunnel 作为入口选项；对从未学会手工配方的新管理员毫无改变。否决，因为需求正是替新管理员去掉手工路径。

**自营共享域名（如 `*.coharness.dev`）。** 能做到真·一键固定域名，但让项目成为边缘运营方——托管成本、滥用治理、可用性责任——只为省一步配置。否决；named 模式用用户自有 Cloudflare zone 即可获得固定域名而不承担该角色。

**只做 quick tunnel。** 零账号即可用，但每次启动 URL 都变且无法固定，不满足"给团队一个稳定地址"的要求。保留为零配置路径，与 named 并列而非独选。

**ngrok 或其他隧道厂商。** 第二个厂商意味着 supervisor、API 客户端、测试都要翻倍而能力相同；Cloudflare 已同时覆盖临时与持久两种模式，单一厂商范围胜出。

## Consequences

- 开启隧道是有意把网关登录面暴露到公网；UI 在操作点写明这一点，每个动作落审计日志。
- Quick 模式 URL 按 Cloudflare 设计是临时的——每次重启签发新的 `*.trycloudflare.com` 名称；UI 如实展示当前 URL 而不伪装稳定。
- Named 模式把 Cloudflare API token 与隧道 run token 以属主专属密钥加密落盘；若运维者希望配置后弃用 API token 可以——重启与恢复只需要 run token。
- 网关现在监管一个长驻的公网入口子进程；其生命周期钉在网关上（关闭即停），二进制缺失时降级为 503 `tunnel-unavailable`/`cloudflared-not-installed` 而非崩溃。
- 启动和配置操作串行执行；停止和清除会在清理之前取消此前接纳的启动。
- 自动状态读取共用一个待完成的轮询。响应超过轮询周期仍能发布结果；动作与查询归属仍会拒绝被变更操作取代的读取。轮询保留表单草稿，不重放操作。

## Verification

Gateway 动作、协议和进程测试覆盖生命周期与配置决策。[生命周期记录](../bug-fix/2026-10-25-gateway-tunnel-lifecycle.zh.md)负责取消、注册证据和真实装配验收。组件屏障覆盖迟到读取、被取消的动作、重试、草稿和剪贴板拒绝。编译后的管理页面浏览器记录使用已认证的 Gateway 路由、真实控制器和本地连接器进程，验证跨越两个浏览器轮询周期的延迟读取、重试、注册前取消、确认连接器关闭，以及复制失败。其内存临时模式记录不能替代 PostgreSQL 验收；两种本地夹具都不证明真实 Cloudflare 可用性。
