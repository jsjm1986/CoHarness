# Agent Note：受管节点运维访问与部署验证

状态：已实现

[English](2026-11-07-managed-node-ops-access-and-deploy-verification.md) | 中文

## 问题

手工执行的节点操作反复造成两类混乱。其一，部署产物两次与源码漂移：一次某节点网关对每个转发请求都返回 `runtime-catalog/forbidden`，而数据库授权检查全部通过——因为只拷贝了直接改动的文件，三个编译产物的间接依赖（`server.js`、`node-service-proxy.js`、`principal.js`）是陈旧版本；之后一次精确 ID catalog 解析记忆化提交了源码且测试全绿，但 `gateway/lib/` 从未重新编译，三个节点运行的是完全相同的陈旧构建。其二，对 Ubuntu 节点的交互式 SSH 看似挂起数分钟：其隧道 key 的 `authorized_keys` 选项为 `restrict,pty,port-forwarding,permitopen="127.0.0.1:9",permitlisten="127.0.0.1:15432",permitlisten="127.0.0.1:18899",command="/bin/sleep 2147483647"`，sshd 会忽略请求的命令而运行保活 sleep。该限制是对隧道凭据的刻意加固，并非连通性故障。

## 决策

针对以 macOS 为锚点的部署（mac-mini 入口、Ubuntu 与 Windows 远程节点），确立两条运维规则。

- **访问 key 按用途分离。** 每节点隧道 key `~/.config/harness-gateway/<node>-db-tunnel/id_ed25519` 仅服务于 launchd 管理的反向隧道；用它发起任何交互命令都会通过认证后阻塞在强制的 `sleep` 中。管理操作使用 `~/.ssh/id_ed25519` 连接 `ubuntu@101.36.115.219`，使用 `~/.ssh/dsh-win-vps-test` 连接 `administrator@47.108.174.138`。隧道 key 的限制本身是特性——正确的做法是选对 key，绝不能放松 `authorized_keys`。
- **网关代码部署是一条有序序列，不是一次拷贝。** 先在 `gateway/` 运行 `npm run build`（测试通过 tsx 跑 `src/`，测试绿不能证明 `lib/` 新鲜）；将 `gateway/lib/` 整个目录 `rsync -a --delete` 同步到每个节点的发布 lib——逐文件拷贝会让编译产物的间接依赖漂移；随后重启各网关（macOS 用 `launchctl kickstart -k gui/<uid>/com.maycran.harness-gateway`,Ubuntu 用 `sudo systemctl restart harness-gateway`,Windows 先 `/end` 再 `schtasks /run /tn HarnessNodeGateway`)；最后验证内容而非一致性——在部署文件上 `grep -c <新符号>` 才能证明改动存在，跨节点校验和只能证明所有节点同样陈旧。随后以 `harness.compute_nodes` 新鲜心跳与 `status='active'` 确认进程健康。
- **Ubuntu 上两条网关车道代码布局不同。** 默认 `harness-gateway.service`（端口 8899）在 `/srv/harness/gateway` 内执行 `node --import tsx/esm src/index.ts`——该车道部署需 rsync `gateway/src/` 与 `deploy/postgres/migrations/`，`lib/` 从不被读取，工作区化的裸 `@deepseek-ai/*` 导入经 `/srv/harness/node_modules/@deepseek-ai/` 符号链接场解析到 `/srv/harness/packages/**`（registry 依赖统一装在 `/srv/harness-deps/node_modules`）。多节点车道不同：`harness-connected-gateway.service`（端口 8999）与 `harness-connected-agent.service` 在 `/srv/harness-node/current/gateway`（指向 `releases/coharness-full-real-<tag>` 的符号链接）下执行 `node lib/index.js` / `node lib/node-agent-main.js`——该车道从发布树读 `lib/` 与 `deploy/`，部署需要与 macOS/Windows 相同的 rsync 载荷，并在同步后 `systemctl restart harness-connected-gateway` 让其重新校验迁移账本。只同步 `src/` 会让 connected 车道留在陈旧的 `node-access-service.js` 上（实测：旧的 4 参 `node_channel_lease` 调用在数据库已要求 5 参后残留，节点本地 service 端点报 `runtime-internal` 500，上游表现为 `node-service/unavailable`）；两条车道分别用自己的 `journalctl -u` 单元诊断。

## 验证

端到端检查是行为级的：重启后通过 `https://harness.maycran.com/` 对同一环境并发发起两个已认证请求，在 PostgreSQL 日志中统计匹配的 `WITH actor AS MATERIALIZED` catalog 语句——一条语句证明记忆化解析器已生效，两条则证明没有。语句捕获本身有一个陷阱：`ALTER DATABASE harness SET log_statement=none` 会在连接建立时按会话覆盖 `ALTER SYSTEM`，因此开启 `log_statement='all'` 后必须搅动池连接（对 `application_name='dsh-gateway'` 的行执行 `pg_terminate_backend`)，捕获结束后再终止一次让安静设置回归，最后恢复库级覆盖。

## 备选方案

**只发布改动文件。** 已否决——它造成了 `forbidden` 故障；编译产物的间接依赖会在源码未变动时漂移。

**跨节点比对校验和。** 已否决——相同的陈旧构建产生相同的摘要；只有内容检查与行为证据能发现缺失的改动。

**放宽隧道 key 以允许管理命令。** 已否决——即使私钥泄漏，隧道凭据也应保持无法获得 shell；独立的管理 key 才是正确的分离。

## 影响

精确 ID catalog 记忆化现在已被证明部署在全部三个节点：两个并发同环境请求在入口网关产生一条 catalog 分页查询，远程节点无额外解析。Ubuntu 管理通过管理 key 正常工作，隧道会话不受影响。尚存的未记录风险是管理 key 清单本身的漂移——若访问再次失败，先检查 `authorized_keys`，再假定网络故障。
