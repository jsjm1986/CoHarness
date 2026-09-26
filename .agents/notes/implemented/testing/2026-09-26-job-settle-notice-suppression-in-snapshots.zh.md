# Agent Note：回放夹具中抑制竞态的 job 完成通知

状态：implemented

[English](2026-09-26-job-settle-notice-suppression-in-snapshots.md) | 中文

## 问题

`missing-sandbox-runner` 编排了一次后台 `bash` 调用，其子进程立即退出（sandbox runner 可执行文件缺失），随后执行带 `wait: true` 的 `job_output`。此处两条运行时时钟存在竞争：若 settlement 时存在 waiter，任务注册表会把终态任务标记为 `reported`；而 `tool-jobs` 会把「未报告」的完成通知 splice 进 agent 收件箱。settlement 先于 `job_output` 挂接 waiter 时通知被注入并投递；waiter 抢先时任务被静默标记为已报告，通知根本不存在。macOS 观测到第一种次序、Linux CI 观测到第二种，同一回放于是产生不同的持久消息数量。

## 决策

保留生产侧 `reported`/通知语义——两种转录都是真实运行的正确输出——改为让*夹具*自身确定，办法是彻底移除竞争：`tests/fixtures/missing-runner-completion-waiter.ts` 注册一个 `tools/execute` waterfall 钩子，在带 `run_in_background` 的 `bash` 调用进入分发前，先通过正在执行的 agent 自身 context 安装 `onJobsChanged` 监听器。监听器落入任务属主的 scope 层，`jobs-local` 因此在注册提交处——即 `start()` 内部、生产者异步 settle 尚未运行之前——就能触达它并无条件挂接 waiter。settlement 于是永远看到 `waiters > 0`、把任务标记为 `reported`，完成通知在所有平台上都被抑制。脚本化的 `job_output wait=true` 读取仍然拿到终态的 `[status: killed, killed before exit]` 记录，runner 失败的证据不变。

scope 路由是决定该机制的约束：`ctx.jobs` 的贡献按注册方 context 的 scope 分层，`onJobsChanged` 只能沿属主的 scope 链触达监听器，而组合层插件 context 看不到会话的注册表。在分发 waterfall 内取得的 agent 自身 `ctx.get('jobs')` 是唯一既在链上、又先于 settlement 的注册点。

## 已考虑的替代方案

- **用额外的脚本化步骤给 settle 让路。** 在 `bash` 与 `job_output` 之间插入 `todo_write` 只是放宽了 settle 窗口，仍是自由运行的时序；Linux CI 上任务依旧在 waiter 挂接之后才 settle。时序余量不是屏障——已被实证否决。
- **改为保证通知被投递。** 要把通知钉在某个固定 step，需要 settlement 落在选定的 pre-step 之前；同样的失控 spawn 延迟在竞争的另一侧同样会击败它。
- **`completionDelivery: 'quiet'`。** 只改变空闲属主的路径；忙碌的属主仍会被注入，竞争依旧存在。
- **脚本化 `job_kill`/`job_output wait=false`。** 它们的结果文本在「任务存活」与「已 settle」两个分支下不同——竞争会转移到工具结果内部重现。
- **修改 `jobs-local` 的 `reported` 语义。** waiter 挂接检查的存在正是为了避免同步的 `job_output` 答复之后还跟一条多余的收件箱通知；为讨好一次回放而抑制真实运行行为，是用产品语义换取夹具便利。
- **按平台拆分夹具或 golden。** 两个宿主机上的转录语义完全相同，只有调度器不同；为一次时序偶发而复制整个场景并不值得。

## 影响

该场景的 session 日志与 stdout golden 无条件固定在被抑制分支：通知从不存在，任何 settle 延迟下消息序号都相同。已投递通知次序的覆盖由 `background-confinement-failure` 保留（其拒绝在准入调用内 settle，构造上即确定），显式 `job_kill` 报告的覆盖由 `background-job-admission` 保留。

## 相关

- [ACP snapshot tests](2026-06-19-acp-snapshot-tests.zh.md) 拥有回放与归一化机制。
- [Snapshot session-identity binding order](2026-09-26-snapshot-session-identity-binding-order.zh.md) 拥有使通知投递令牌稳定的认领次序。
