# Agent Note: 返回的 stdin 等待须保持到输出流静默

Status: implemented

[English](2026-11-19-stdin-wait-return-holds-until-output-quiet.md) | 中文

## 问题

`LocalPtySession.pollReadiness` 有两条路径把 send 结算为 `stdin_read`。prompt 路径要求 prompt 证据落地后输出流静默一个轮询周期(`idleFor >= pollIntervalMs`)。exact 路径——`acceptsStdinWait` 接受观测到的 `inputWaiting` 回归——原本没有任何静默要求。

等待的回归观测领先于字节流:刚恢复 stdin 读取的 shell 已经吐完了它要吐的一切,但最后一批字节可能仍在内核 pty 缓冲到 Node 流之间在途。按裸观测结算,就把这些字节交给了下一条 send 的捕获窗口。

coverage lane 的 `tool-pwsh-persistent` 转储呈现了完整交错:`large-output` send(`1..12050 | ForEach-Object { $_ }`)在 617ms 以 `promptSeen=false` 结算 `stdin_read`,它最后观测到的 chunk——洪水第 12031 行——仅在 4ms 前到达。剩余约 20 行、该命令的 `END` 标记和它的 prompt 全部落进了下一条(`exit`)send 的窗口,而 exit 自己又在 16ms 内凭消耗前的等待观测结算。`partialOutput` 随后在整个捕获里找不到 `exit` 的 `START` 标记,回退为整体 `incomplete`,工具返回 `LOST_PREFIX` 后接洪水第 12038–12045 行——上一条命令的尾巴被当成了下一条命令的输出。同一 spec 在多个不相关 PR 的 coverage 与 windows-native lane 上反复失败。

## 决策

exact 结算现在要求与 prompt 路径相同的静默边界:`pollReadiness` 仅当 `idleFor >= pollIntervalMs`——最近一个轮询周期内没有输出 chunk 到达——才在接受的等待回归上结算 `stdin_read`。一个静默轮询把在途尾巴排进正在结算的 send 自己的缓冲,下一条 send 的捕获窗口从前一条命令的字节之后才开始。

`acceptsStdinWait` 的离开侧不变:武装仍要求 [stdin 等待的离开须跨连续轮询持续](2026-11-17-stdin-wait-departure-sustained.zh.md) 记录的连续忙观测;只有回归的接受新增了排空条件。交互式子进程分支(`processGroupId !== initialForegroundPgid`,直接返回 `inputWaiting`)在同一结算点继承该门:子进程的最后一段输出突发同样在结算前排空。

## 备选方案

- 在这条路径上同样要求命令的 `END` 标记或 prompt——拒绝:exact 路径存在的意义正是承载输出中没有 prompt 标记的 send(churn 下的静默命令、交互式子进程),且标记语义属于 `tool-pwsh-persistent` 而非终端层。
- 把结算后到达的 chunk 归还给上一条 send 的缓冲——拒绝:session 无法区分正在结算命令的排空尾巴与并发写者的输出;静默窗口是流自身暴露的唯一边界。
- 与流无关的固定排空延迟——拒绝:`pollIntervalMs` 本就是 prompt 路径使用的采样量子,该边界随配置节奏自缩放,流真正静默后不增加延迟。

## 后果

- 字节仍在到达的 send 最多比观测到的等待回归晚一个轮询周期结算 `stdin_read`;已静默的命令零代价——`exactProbeAfterMs`(默认 150ms)本就超过一个轮询周期(50ms)。
- 命令的 `END` 标记与 prompt 现在落在自己的 send 窗口内,`tool-pwsh-persistent` 的按命令标记关联与 scrollback 核算重新成立;返回的 `incomplete`/`LOST_PREFIX` 重新只表示真实的 scrollback 丢失而非在途排空。
- [Prompt 结算要求 post-write 输出证据](../architecture/2026-11-16-prompt-evidence-requires-post-write-output.zh.md) 的不变量现在对称覆盖两条快速路径:任何一条都不按在途流仍可推翻的证据结算。
- `inferred_idle` 仍是声明的降级层,无需排空门——它只在 `idleSilenceMs` 静默后触发,该静默本就覆盖了尾巴。

## 验证

- `packages/terminal/terminal-bash/tests/session.spec.ts` —— 62/62,含新增的 `holds a returned stdin wait until the output stream goes quiet for one poll`:复放 CI 交错(两次忙轮询武装离开、等待回归时 `tail` chunk 仍在到达、一个静默轮询后才结算)。stash 掉 `session.ts` 改动后该测试在未结算断言处确定性失败。
- `packages/terminal/terminal-bash` 套件 —— 123/124(1 skipped);`packages/shell/tool-pwsh-persistent` 套件含真实 `loader-composition.spec.ts` pwsh 组合本地通过。
