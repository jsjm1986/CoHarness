# Agent Note: Workbench 指针 trace 为页面 evaluate 设界

Status: implemented

[English](2026-11-12-workbench-trace-bounded-evaluate.md) | 中文

## 问题

`apps/web/tests/workbench.e2e.ts` 中的 `traceWorkbenchTabs` 为指针输入场景给页面插桩。其宿主侧 `trace.evaluate` 调用(`mark`、`stop`、`dispose`）没有截止期：当渲染进程主线程不再应答——观测形态为布局突变风暴钉住页面——调用永不落定,vitest 的 `testTimeout` 无法打断一个悬空的协议 await,整个 `web verification` 作业静默约 35 分钟直到步骤级超时将其杀死且不产生失败测试报告。同一特征（最后输出为 `[workbench-pointer-restoration] {"scenario":"preview-width","restored":true}`）出现在五次 CI 运行中，涉及的分支 diff 不含任何 web 代码，使无关合入被一个必需 check 阻塞。

## 决策

- MutationObserver 在 256 行缓冲饱和后断开：超过上限后每次投递仍会对整个 pane DOM 执行 `JSON.stringify(snapshot())`，恰在 `stop()` 需要主线程时持续占用它。饱和后的 mutation 只递增 `dropped`，保留既有 `dropped === 0` 绊线。
- `mark`、`stop` 与 `dispose` 统一经一个 15 秒 `Promise.race` 截止期求值。冻结页面现在让所属测试在数秒内带着明确信息失败，而不是冻结整个套件。`dispose` 尽力而为，因为已死的通道同样不会应答释放；浏览器收尾无论如何都会回收句柄。竞速中落败的 Promise 附带 `.catch`，迟到的拒绝不会冒成 unhandled rejection。

## 曾考虑的替代方案

- **依赖 vitest `testTimeout`**——它无法打断一个 Promise 永不落定的协议 await;worker 在预算后仍保持静默，这正是观测到的失败。
- **对 observer 做节流而非断开**——防抖仍会对每轮突变风暴执行全 DOM stringify，同一个饿死通道依旧存在。
- **CI 下直接去掉 trace**——trace 正是诊断真实指针回归的手段；给工作设界保留了它。

## 影响

冻结页面降级为一次正常的、可归因的测试失败(`Workbench tab trace stop exceeded 15000 ms`）而非静默的作业死亡，`web verification` 因而报告肇事测试，其余文件的证据也得以保留。正常运行不受影响：截止期远高于实测亚秒级的 evaluate 延迟，而 observer 也只在测试本就判失败的上限之后才断开。
