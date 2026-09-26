# Agent Note：回放夹具中的后台任务 settle 节奏控制

状态：implemented

[English](2026-09-26-job-settle-pacing-in-snapshots.md) | 中文

## 问题

`missing-sandbox-runner` 编排了一次后台 `bash` 调用，其子进程立即退出（sandbox runner 可执行文件缺失），随后仅隔一步就执行带 `wait: true` 的 `job_output`。此处两条运行时时钟存在竞争：任务注册表在 waiter 挂接的瞬间就把终态任务标记为 `reported`，而 `tool-jobs` 在下一个 step 边界把「未报告」的完成通知 splice 进 agent 收件箱。若 settle 先于 `job_output` 挂接 waiter 完成，通知会被注入并投递；若 waiter 抢先，任务被静默标记为已报告，通知根本不存在。macOS 观测到第一种次序、Linux CI 观测到第二种，同一回放于是产生不同的持久消息数量，stdout golden 末尾的 `{{message:N}}` 令牌随之在两个值之间摆动。

## 决策

保留生产侧 `reported`/通知语义——两种转录都是真实运行的正确输出——改为让*夹具*自身确定：脚本化模型现在在后台 `bash` 调用与 `job_output` 之间插入一个 `todo_write` 步骤。ENOENT spawn 的失败 settle 在微秒级完成，隔了完整一步后，settle 及其收件箱 splice 必然先于 `job_output` 挂接 waiter 完成；通知必定被注入、投递并获得稳定编号。两种合理的 splice 落位（`todo_write` 步骤之前或 `job_output` 之前）都会让最终回复得到相同的 stdout 可见令牌，因此任一平台时序下 golden 都成立。

`background-confinement-failure` 已证明了兄弟次序——settle 发生在启动该任务的那次调用之内；`background-job-admission` 则让任务存活到显式 `job_kill` 来规避竞争。需要「已 settle 且已通知」状态的夹具采用这种节奏步骤；需要相反次序的夹具保持 waiter 优先。

## 已考虑的替代方案

- **修改 `jobs-local` 的 `reported` 语义。** waiter 挂接检查的存在正是为了避免同步的 `job_output` 答复之后还跟一条多余的收件箱通知；为讨好一次回放而抑制真实运行行为，是用产品语义换取夹具便利。
- **放弃 wait、读两次任务输出。** `wait: false` 的读取与 settle 本身竞争，捕获到的输出文本将随调度变化——比被取代的次序问题更糟。
- **把 golden 刷新成 Linux 次序。** 漂移源于调度而非行为变化；提交任一次序都会让另一平台保持红色。
- **按平台拆分夹具或 golden。** 两个宿主机上的转录语义完全相同，只有调度器不同；为一次时序偶发而复制整个场景并不值得。

## 影响

authored 夹具可以出于节奏目的编排额外步骤；一个仅用于约束异步 settle 边界的步骤属于场景确定性的一部分，而非冗余。回放不引入 sleep：节奏控制成立是因为 settle 的属主是真实子进程，其失败领先下一个脚本化调用整整一个 step 边界，而不是依赖墙钟延迟。

## 相关

- [ACP snapshot tests](2026-06-19-acp-snapshot-tests.zh.md) 拥有回放与归一化机制。
- [Snapshot session-identity binding order](2026-09-26-snapshot-session-identity-binding-order.zh.md) 拥有使通知投递令牌稳定的认领次序。
