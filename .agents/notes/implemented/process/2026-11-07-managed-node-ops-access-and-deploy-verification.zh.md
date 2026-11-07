# Agent Note：受管节点运维访问与部署验证

状态：已实现

[English](2026-11-07-managed-node-ops-access-and-deploy-verification.md) | 中文

## 问题

手工执行的节点操作反复造成两类混乱。其一，部署产物两次与源码漂移：一次某节点网关对每个转发请求都返回 `runtime-catalog/forbidden`，而数据库授权检查全部通过——因为只拷贝了直接改动的文件，三个编译产物的间接依赖（`server.js`、`node-service-proxy.js`、`principal.js`）是陈旧版本；之后一次精确 ID catalog 解析记忆化提交了源码且测试全绿，但 `gateway/lib/` 从未重新编译，三个节点运行的是完全相同的陈旧构建。其二，对 Ubuntu 节点的交互式 SSH 看似挂起数分钟：其隧道 key 的 `authorized_keys` 选项为 `restrict,pty,port-forwarding,permitopen="127.0.0.1:9",permitlisten="127.0.0.1:15432",permitlisten="127.0.0.1:18899",command="/bin/sleep 2147483647"`，sshd 会忽略请求的命令而运行保活 sleep。该限制是对隧道凭据的刻意加固，并非连通性故障。

## 决策

针对以 macOS 为锚点的部署（mac-mini 入口、Ubuntu 与 Windows 远程节点），确立两条运维规则。

- **访问 key 按用途分离。** 每节点隧道 key `~/.config/harness-gateway/<node>-db-tunnel/id_ed25519` 仅服务于 launchd 管理的反向隧道；用它发起任何交互命令都会通过认证后阻塞在强制的 `sleep` 中。管理操作使用 `~/.ssh/id_ed25519` 连接 `ubuntu@101.36.115.219`，使用 `~/.ssh/dsh-win-vps-test` 连接 `administrator@47.108.174.138`。隧道 key 的限制本身是特性——正确的做法是选对 key，绝不能放松 `authorized_keys`。
- **网关代码部署是一条有序序列，不是一次拷贝。** 先在 `gateway/` 运行 `npm run build`（测试通过 tsx 跑 `src/`，测试绿不能证明 `lib/` 新鲜）；将 `gateway/lib/` 整个目录 `rsync -a --delete` 同步到每个节点的发布 lib——逐文件拷贝会让编译产物的间接依赖漂移；随后重启各网关（macOS 用 `launchctl kickstart -k gui/<uid>/com.maycran.harness-gateway`,Ubuntu 用 `sudo systemctl restart harness-gateway`,Windows 先 `/end` 再 `schtasks /run /tn HarnessNodeGateway`)；最后验证内容而非一致性——在部署文件上 `grep -c <新符号>` 才能证明改动存在，跨节点校验和只能证明所有节点同样陈旧。随后以 `harness.compute_nodes` 新鲜心跳与 `status='active'` 确认进程健康。

## 验证

端到端检查是行为级的：重启后通过 `https://harness.maycran.com/` 对同一环境并发发起两个已认证请求，在 PostgreSQL 日志中统计匹配的 `WITH actor AS MATERIALIZED` catalog 语句——一条语句证明记忆化解析器已生效，两条则证明没有。语句捕获本身有一个陷阱：`ALTER DATABASE harness SET log_statement=none` 会在连接建立时按会话覆盖 `ALTER SYSTEM`，因此开启 `log_statement='all'` 后必须搅动池连接（对 `application_name='dsh-gateway'` 的行执行 `pg_terminate_backend`)，捕获结束后再终止一次让安静设置回归，最后恢复库级覆盖。

## 备选方案

**只发布改动文件。** 已否决——它造成了 `forbidden` 故障；编译产物的间接依赖会在源码未变动时漂移。

**跨节点比对校验和。** 已否决——相同的陈旧构建产生相同的摘要；只有内容检查与行为证据能发现缺失的改动。

**放宽隧道 key 以允许管理命令。** 已否决——即使私钥泄漏，隧道凭据也应保持无法获得 shell；独立的管理 key 才是正确的分离。

## 影响

精确 ID catalog 记忆化现在已被证明部署在全部三个节点：两个并发同环境请求在入口网关产生一条 catalog 分页查询，远程节点无额外解析。Ubuntu 管理通过管理 key 正常工作，隧道会话不受影响。尚存的未记录风险是管理 key 清单本身的漂移——若访问再次失败，先检查 `authorized_keys`，再假定网络故障。
