# Agent Note: 同版本 Gateway 重启间保留 Runtime 幸存进程

状态：已实现

[English](2026-11-11-runtime-survivor-retention.md) | 中文

## 问题

`LocalLauncher.instancesOutliveGateway=false` 意味着每次 Gateway 优雅停机都会排空全部本地 Runtime(`stopAll` → `stop_reason='shutdown'`)。在活跃迭代的 mac-mini 上，每次部署后用户打开任何空间都要经历约 13 秒的冷启动——这是「打开前端就等很久」的主要来源。`systemd` 节点早已能在重启间保留 Runtime；local launcher 的排空是策略选择而非技术限制：owner 记录、凭证哈希、principal 密钥与 supervisor 内核租约都能在 Gateway 进程重启后存活。

## 决策

local launcher 默认保留幸存进程，但用**启动签名**做闸而非盲目信任。

- `boot-signature.ts` 计算 `RuntimeBootSignature`——release root、dsh repo root、Node 版本/路径、launcher 种类、完整 `dshCommand`、解析出的 dsh 入口脚本与 supervisor 源文件的 SHA-256、以及仓库 `git HEAD`——原子写入 `<stateRoot>/boot-signature.json`(0600)。
- `index.ts` 在对外服务前比对记录与计算结果。一致 → 幸存进程保持 adopted，走既有 `attachSurvivor`/`liveEndpoint` 路径重连；不同或缺失 → `instances.drainSurvivors('shutdown')` 在 `server.listen` 前经正常 `stop` 管道排空。
- `stopAll(retainLocalSurvivors)` 保持历史排空为默认（129 处测试/清理调用点依赖）；生产 shutdown 传 `!cfg.drainRuntimesOnShutdown`。`HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=true` 恢复旧语义，供需要「关停即释放」的运维场景。
- `drainSurvivors` 与 `stopAll` 共用限流并发的 `drainTargets` 辅助；逐目标失败收集后取第一个抛出。

## 已考虑的替代方案

**部署脚本写 marker 文件。** 部署侧开关无法覆盖绕过脚本的升级；对真实启动输入（入口/supervisor 内容、release root)hash 让兼容性判定自证。

**local 直接设 `instancesOutliveGateway=true`。** 能去掉停机排空但完全放弃升级护栏：新版本会无限期重连旧代码幸存进程。

## 影响

同版本重启零冷启动：Runtime 行保持 `ready`,generation 不增，supervisor 与子进程端口不变。升级、launcher 切换或 Node 工具链变化仍保守排空。已 adopted 但行已 stopped 的租约保持既有 fail-safe：下一任 manager 在确认终止前持续计为 resident，无凭证哈希的 legacy 行依旧拒绝重连而非凭空授权。

一个实测的启动期交互：排空持有逐目标序列化与 Postgres 锁，该窗口内并发被动 `ensureRunning` 可能撞上节点资源准入超时；重试即自愈（实测：admin 个人 Runtime 同一次启动内 `starting` → `ready`)，但排空在活跃站点下会产生短暂准入停顿。

## 验证

- `boot-signature.spec.ts`：往返读写、畸形/缺失 → 判缺失、入口内容变化只翻 `entrySha256`、release root 迁移改变签名（3/3)。
- `instances.spec.ts`:`drainSurvivors` 在 `unread`/`isLive`/`ensureRunning` 三种读取后重连并终止 adopted 幸存进程；真实 `FAKE_DSH` 子进程在 `stopAll(true)` 后继续服务 HTTP、行保持 `ready`，下一任 manager 计其为 resident（套件 98/98)。
- `config.spec.ts`：默认 `drainRuntimesOnShutdown=false`,`true`/`false` 合法，其他值报错（与签名套件合计 45/45)。
- 生产 mac-mini:r54→r55 启动排空全部 5 个旧 supervisor（签名缺失 → 保守方向）并写入 `boot-signature.json`；随后同版本 `launchctl kickstart -k` 后 supervisor `16635` + 子进程 `16637`（端口 42000）存活，行保持 `ready` gen 14088 不变，无排空日志。
