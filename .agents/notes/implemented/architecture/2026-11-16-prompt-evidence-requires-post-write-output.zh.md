# Agent Note: Prompt 结算要求写后输出证据

状态： 已实现

[English](2026-11-16-prompt-evidence-requires-post-write-output.md) | 中文

## 问题

`LocalPtySession.pollReadiness` 在受控 prompt marker、其可打印尾部与 shell 前台进程组三者于 send 窗口内对齐时以 `stdin_read` 结算该 send。该证据没有代际边界：上一条命令发出的尾部 prompt 重绘可能落入后一个 send 的窗口——该 send 的 `resetReadinessEvidence` 已经执行，陈旧 chunk 于是置位 `promptSeen`/`promptTextSeen`；shell 此时确实占有前台进程组（它就停在那个 prompt 上），send 在其写入的输入被消费之前就已结算。`tool-pwsh-persistent` 随后把这段部分增量——仅一个 prompt——渲染成命令输出。

CI 轨迹完整呈现了该竞态：`observe` send 在 +1595ms 写入其 417 单元的包装命令，上一条命令的 `\x1b]133;D;0\x07dsh> ` 重绘在同一毫秒到达，`inspectForeground` 在消费前的轮询上报 `inputWaiting`,send 于 16ms 后以 `stdin_read` 结算。覆盖率通道的负载把该交错窗口拉大至反复命中；同样的碰撞在任何时序下都可能发生。

## 决策

写入输入的 send 只有在观察到陈旧重绘无法提供的证据之后，才能把某个 prompt marker 归因于自己。`LocalSendOperation` 记录写入的输入（`noteInput`）并吸收其回显：`absorbEcho` 将净化后的 chunk 与按空白归一化的输入匹配——包括 PSReadLine 换行重绘片段与纯空白的提交回显——而不武装任何证据。`promptEvidenceArmed` 在 send 观察到真实输出（`sawNonPromptOutput`：非 prompt 尾、非 `CONTROLLED_PROMPT` 片段、且不可被输入回显吸收的文本）时成立，或在回显重放完成（`echoMatched` 覆盖全部输入）时成立。真实 tty 先回显输入再打印下一个 prompt，因此任一信号都标记了陈旧重绘无法跨越的边界。

`promptSeen` 本身也以武装状态为门：在活跃 send 未武装期间到达的 marker chunk 被判定为上一条命令的重绘而丢弃，不置位任何 prompt 证据。`pollReadiness` 的 prompt 分支同样继续要求 `promptEvidenceArmed`。

回显吸收不得吞掉同时出现在输入中的字面输出。持久 shell 运行 `stty -echo`，回显根本不会到达——然而 wrapper 自身的 `printf '<start marker>'` 输出是写入 wrapper 的子串，若按回显匹配，`exec` 替换出的 shell 将永远无法武装（其唯一结算路径是替换后 shell 的 prompt)。`absorbEcho` 因此按位置匹配——`lastIndexOf(fragment, echoMatched)`——连续回显、重叠与回溯重绘被吸收，而出现在回显覆盖位置之前的输出仍计为证据。

空 send(`text: ''`）从不置位 `expectsEcho`，仍仅凭 prompt 证据结算；它们是工具循环的等待迭代，提前返回无损。探针路径（`acceptsStdinWait`）本就要求前台进程组自 send 开始后离开过输入等待，保持不变。

## 影响

- 写入输入的 send 不再能凭落在回显中途或先于自身输出的 prompt 重绘以 `stdin_read` 结算；命令得以执行，其 marker 落地，结算发生在真正的命令后 prompt 上。
- 输入回显同样不构成消费证据：第二个 CI 败因正是包装命令的回显尾部武装了陈旧 prompt，使回显尾被当作命令输出返回。吸收逻辑同时覆盖不含可见文本的回车/换行提交回显。
- `stty -echo` shell（持久 bash 后端）不产回显；其 send 由 wrapper 的 marker 输出武装——位置匹配使 marker 文本虽嵌在输入中也能与回显区分。
- 静默命令（`cd`、`export`）仍可在其 prompt 上结算：完成的回显重放即消费证据，因此回显后的 prompt 被接受，而回显中途的 prompt 被拒绝。
- 那些在写入后仅注入 prompt、不注回显的 fake-terminal 测试已补上真实 tty 必然产生的回显；回归测试逐帧复现了两种 CI 交错（回显之前的陈旧重绘，以及部分输入回显中的陈旧 prompt)。
- 输入在 `ECHO` 关闭期间被消费、或回显始终无法匹配写入字节的 send 退化为静默层而非快速 prompt 路径：结果仍正确，工具循环依然能观察到命令的 marker。
- `pty-delayed-signal-prompt` TODO 所述的 marker 代际边界在 prompt 结算路径上得以实现：send 自身输出或回显之前的证据无法再武装结算。

## 已考虑的替代方案

- 在 prompt 路径复用 `acceptsStdinWait` 的 `initialForegroundLeftWait` 记忆——否决：轮询以 `pollIntervalMs` 采样 `inputWaiting`，快命令可以在一个间隔内完成消费输入、执行并回到等待。错过该转换会把每个快 send 降级到静默边界，这正是 `stdinReads >= 6` 钉住项所禁止的。
- 在 pty 流中重新匹配写入字节的回显——部分采纳：PSReadLine 用交错高亮重绘输入，回显不是字节稳定的，精确匹配不可行；按空白归一化的子串吸收不依赖重绘布局即可识别片段，且匹配饱和可为静默命令武装证据。
- 在 `tool-pwsh-persistent` 的 `stdin_read` 分支中先等起始 marker 再返回——否决：工具无法区分合法读取 stdin 的交互式子进程（必须快速返回）与未被消费的写入；只有终端层能看到前台进程组与流顺序。

## 验证

- `packages/terminal/terminal-bash/tests/session.spec.ts` — 59/59，包括 `does not settle a send on a prompt repaint that lands before its own echo`、`does not settle on a stale prompt inside a partial input echo`（覆盖率通道的回显尾签名）与 `settles a silent command on its post-echo prompt`。
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` 及整个 `terminal-bash` + `tool-pwsh-persistent` 套件——本地 168/169(1 跳过），覆盖 CI 失败所来自的真实 pwsh 组合。
