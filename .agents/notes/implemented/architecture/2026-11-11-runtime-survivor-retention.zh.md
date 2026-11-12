# Agent Note: 以启动戳保留 Runtime 幸存进程

Status: implemented

[English](2026-11-11-runtime-survivor-retention.md) | 中文

## 问题

`LocalLauncher.instancesOutliveGateway=false` 意味着每次 Gateway 优雅关闭都会排空所有本地 Runtime(`stopAll` → `stop_reason='shutdown'`)。在开发用 Mac mini 上，每次发版都让每个空间在下次进入时付出约 13 秒的冷启动——这是「打开 UI 就干等」的最大来源。`systemd` 节点的 Runtime 本来就能跨重启存活；本地启动器选择排空是策略而非技术必需：owner 记录、凭证哈希、主体密钥与 supervisor 内核租约都能跨 Gateway 进程重启存活。

## 决策

本地启动器默认保留幸存进程，但改用逐代 **launch stamp** 把关，替代原先的全局签名文件。

- `launch-stamp.ts` 提供 `computeLaunchStamps(cfg, principalPublicKey, profile)`：对 Runtime 代码闭包（`dshRepoRoot` 下的 `apps`、`packages`、`vendor`、`plugins` 及 lockfile)、解析后的 supervisor 源码、规范化后的 `dshCommand`(node 二进制记 `process.version`、`argv[1]` 入口脚本记内容摘要、之后的参数记字面文本——运行时新建的文件不进签名）、启动器类型、node 可执行文件路径与版本、profile、凭证格式（`principalPublicKey`、`streamPrincipalRenewal`)、默认 env 文件以及每个物化策略包（governance、guard、steward 工具、桌面驱动）做内容摘要。基础摘要再按**启动变体**(`admin` × `kind` × `steward`）与 `mountPolicyBundles` 实际写入的同一份 `policyPatchText` 组合，使行内戳记录该代启动时的全部输入。
- `beginStart` 按描述符所属变体铸戳，并在认领 generation 的同一事务里持久化为 `instances.launch_stamp`(SQLite schema 10,Postgres 迁移 129)。策略输入缺失的变体无法铸戳：`stampFor` 会抛出与挂载时相同的配置错误，且不消耗 generation；失败的尝试仍会为现有 generation 发布静默事件，让排队的资源工作被唤醒。若所有变体都无法铸戳，戳计算整体失败——`retireIncompatibleSurvivors` 此时不退休任何进程，由请求期围栏暴露配置错误，而不是杀掉健康进程。
- 服务请求之前，`index.ts` 调用 `instances.retireIncompatibleSurvivors()`：记戳不在已铸集合内的收养幸存进程——包括 `NULL` 的旧行——经由正常 `stop` 管线按 `shutdown` 停掉；戳匹配的行保持收养状态，经 `attachSurvivor`/`liveEndpoint` 重连。
- 同一道围栏惰性生效：`liveEndpoint` 对戳未铸中的 ready 行返回 `null`;`ensureRunningNow` 在转入全新启动前，按观测到的 generation 以 `shutdown` 终止该幸存进程；reconcile 探活对戳不兼容的 ready 行按 `shutdown` 退休，与死亡探测路径一样按代围栏。停不掉的幸存进程保持被挡状态，不会被重新接上。
- `stopAll(retainLocalSurvivors)` 仍以排空为默认（大量测试清理调用点依赖它）；生产关闭路径传 `!cfg.drainRuntimesOnShutdown`。运维者想要「关闭即排空」旧语义时可设 `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN=true`。
- 先前的全局 `boot-signature.json` 机制（目标相同，输入更粗：发布路径、入口文件哈希、git HEAD）被替换，因为它既看不见原地重建，又会在内容逐字节相同的换目录发版时照样排空全部。

## 备选方案

**由部署脚本写标记文件。** 部署侧的可选开关无法表达绕过脚本的升级；对真实启动输入做哈希让兼容性判定可以自证。

**直接把本地启动器设为 `instancesOutliveGateway=true`。** 能去掉关闭时的排空，但完全丢掉升级保护：新版本会无限期地重连旧代码幸存进程。

**保留全局 boot 签名。** 它只对网关自身的薄入口与 supervisor 文件哈希，因此路径不变的 Runtime 代码变化检测不到（原地重建），而逐字节相同的新目录发版却照样全排空。逐行内容戳让两个方向都正确。

## 影响

同内容重启与仅改网关的发版零冷启动：Runtime 行保持 `ready`,generation 不变，supervisor 与子进程保住端口。Runtime 代码、启动输入、凭证格式或工具链变化则保守退休，该行下次进入时冷启动。已收养但已停止的行保留原有兜底：下一次启动的管理器在确认终止前都把其租约按常驻计数；缺凭证哈希的旧行仍然拒绝重连，而不是凭空授予权限。

由生命周期中途的配置变化引起的戳不匹配（例如轮换默认 env 文件）与代码变化一样退休幸存进程——这是刻意的，因为这些输入本就该计入该代的启动内容。角色变化（member→admin)会让幸存进程按其已记录的变体保持连接，直到下一代；每次请求的使用期策略检查照常生效。

旧 release 目录在仍有幸存进程从它运行时不得删除：幸存进程的代码闭包是惰性加载的，即使其行能通过围栏，删掉目录也会弄坏一个被保留的进程。

## 验证

- `launch-stamp.spec.ts`：铸戳确定性、逐变体戳互不相同、闭包内容变化使全部戳翻转、相同内容换路径铸出相同集合、缺 governance 包时整组失败，以及 `policyPatchText` 只在对应变体中内嵌 admin/steward 覆盖层（6/6)。
- `instances.spec.ts`：戳不兼容的幸存进程分别被 `retireIncompatibleSurvivors`、`ensureRunning` 与 reconcile 探活按 `shutdown` 退休；戳已铸中的幸存进程保持收养并重连；一次真实 `FAKE_DSH` 启动把成员戳写入 `instances.launch_stamp`(109/109)。
- 生产 mac-mini:r54→r55 启动排空全部 5 个旧 supervisor；同版本 `launchctl kickstart -k` 后 supervisor `16635` 与子进程 `16637`(42000 端口）存活、行保持 `ready` 且 generation 不变；重启后一次带认证的代理请求 33ms 返回。
