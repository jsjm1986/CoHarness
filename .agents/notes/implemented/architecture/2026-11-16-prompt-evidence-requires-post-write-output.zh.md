# Agent Note: Prompt 结算要求写后输出证据

状态： 已实现

[English](2026-11-16-prompt-evidence-requires-post-write-output.md) | 中文

## 问题

`LocalPtySession.pollReadiness` 在受控 prompt marker、其可打印尾部与 shell 前台进程组三者于 send 窗口内对齐时以 `stdin_read` 结算该 send。该证据没有代际边界：上一条命令发出的尾部 prompt 重绘可能落入后一个 send 的窗口——该 send 的 `resetReadinessEvidence` 已经执行，陈旧 chunk 于是置位 `promptSeen`/`promptTextSeen`；shell 此时确实占有前台进程组（它就停在那个 prompt 上），send 在其写入的输入被消费之前就已结算。`tool-pwsh-persistent` 随后把这段部分增量——仅一个 prompt——渲染成命令输出。

CI 轨迹完整呈现了该竞态：`observe` send 在 +1595ms 写入其 417 单元的包装命令，上一条命令的 `\x1b]133;D;0\x07dsh> ` 重绘在同一毫秒到达，`inspectForeground` 在消费前的轮询上报 `inputWaiting`,send 于 16ms 后以 `stdin_read` 结算。覆盖率通道的负载把该交错窗口拉大至反复命中；同样的碰撞在任何时序下都可能发生。

## 决策

写入输入的 send 在其 prompt 路径可结算之前，必须观察到 prompt 重绘无法提供的输出。`LocalSendOperation` 携带两个证据位：`expectsEcho` 在 `beginSend` 实际写入输入时置位；`sawNonPromptOutput` 在某个净化后的 chunk 携带 prompt 无法解释的文本时置位——即超出该 chunk 自身 `promptTail` 的文本、不等于 `CONTROLLED_PROMPT` 片段、且不在未完成的 prompt 尾窗口内。`pollReadiness` 的 prompt 分支现在同时要求 `operation.promptEvidenceArmed`。

空 send(`text: ''`）从不置位 `expectsEcho`，仍仅凭 prompt 证据结算；它们是工具循环的等待迭代，提前返回无损。探针路径（`acceptsStdinWait`）本就要求前台进程组自 send 开始后离开过输入等待，保持不变。

## 影响

- 写入输入的 send 不再能凭先于自身回显、输出或 marker 字节的裸 prompt 以 `stdin_read` 结算；命令得以执行，其 marker 落地，结算发生在真正的命令后 prompt 上。
- 那些在写入后仅注入 prompt、不注回显的 fake-terminal 测试已补上真实 tty 必然产生的回显；新增的回归测试逐帧复现了 CI 交错（send 窗口内落入陈旧重绘，随后回显、输出与 prompt)。
- 输入在 `ECHO` 关闭期间被消费的 send 退化为静默层而非快速 prompt 路径：结果仍正确，工具循环依然能观察到命令的 marker。
- `pty-delayed-signal-prompt` TODO 所述的 marker 代际边界在 prompt 结算路径上得以实现：send 自身输出之前的证据无法再武装结算。

## 已考虑的替代方案

- 在 prompt 路径复用 `acceptsStdinWait` 的 `initialForegroundLeftWait` 记忆——否决：轮询以 `pollIntervalMs` 采样 `inputWaiting`，快命令可以在一个间隔内完成消费输入、执行并回到等待。错过该转换会把每个快 send 降级到静默边界，这正是 `stdinReads >= 6` 钉住项所禁止的。
- 在 pty 流中重新匹配写入字节的回显——否决：PSReadLine 用交错高亮重绘输入，回显不是字节稳定的；"任何非 prompt 输出"才是稳健的消费信号。
- 在 `tool-pwsh-persistent` 的 `stdin_read` 分支中先等起始 marker 再返回——否决：工具无法区分合法读取 stdin 的交互式子进程（必须快速返回）与未被消费的写入；只有终端层能看到前台进程组与流顺序。

## 验证

- `packages/terminal/terminal-bash/tests/session.spec.ts` — 57/57，包括新增的 `does not settle a send on a prompt repaint that lands before its own echo`，逐帧重放 CI 失败交错。
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 及整个 `terminal-bash` + `tool-pwsh-persistent` 套件——本地 166/167(1 跳过），覆盖 CI 失败所来自的真实 pwsh 组合。
