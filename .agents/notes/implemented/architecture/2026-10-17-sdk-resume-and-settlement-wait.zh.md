# Agent Note: SDK 线路上的会话恢复与结算等待

Status: implemented

[English](2026-10-17-sdk-resume-and-settlement-wait.md) | 中文

## 问题

SDK JSON-RPC 表面只有隐式建会话一条路：`session/prompt` 在没有存活 agent 认领时直接以传入的 `sessionId` 建会话。两个生命周期需求在线路上无从表达。运行时重启后，客户端无法重新挂接到某个持久化身份——用旧 id 发起 prompt 会伪造一段空历史还顶着旧名，任何不可恢复的对象都会静默变成新会话而非报错。客户端也无法观测结算：`session/prompt` 在请求被受理时返回，`session.event` 通知流从不声明一个 turn——包括仍在受委派后裔内运行的 turn——已经结束。

## 决策

`session/resume { sessionId }` 把存活 agent 重新挂接到持久化会话，不发送模型请求。服务端经 `ctx.agents.resume({ resumeSessionId })` 恢复，因此持久化身份、头部与事件历史原样接管，后续 turn 延续日志自身的编号，追加落在同一日志代际上。resume 对缺失、不可读、不兼容或已打开的身份一律拒绝，绝不静默新建——查找失败不得顶着实名伪造空历史。可恢复但中断的日志在加载时修复，这是持久层自身属性，线路操作原样继承。

`session/wait { sessionId }` 从客户端侧结算一个会话：先等根 agent 到达空闲点，再并入 `ctx.subagents.waitForChildren`，使仍挂在根下运行的委派工作计入结算，随后复查根序列号，让晚到的子触发 turn 无法把 wait 滑过该 turn 已发出的事件。服务端按 `SessionLogOffset` 记录 `agent/error` 上的存活 agent 故障；wait 会上报该故障，除非偏移量不晚于它的终止 `turn/end` 已将其取代，因此陈旧故障不会毒化后续健康 turn。

两个操作都经过 `assertLiveAgent`，服务端为每个认领的会话维护 `SessionRecord`——prompt、wait、resume 与 working-directory 操作共享同一条存活性路径。显式恢复走 `openSession(sessionId, 'resume')`，与 prompt 时的隐式创建保持区分。Shutdown 先排空 `drainContinuableDescendants` 再释放根 agent，确保没有根在其托管的子还能追加时被拆除。

## 备选方案

**在 `session/prompt` 内隐式 resume。** 把未知 id 当作“可恢复则恢复，否则新建”抹掉了重挂接与创建的差别；id 打错会以调用方以为是历史会话的名字新建一个全新会话。

**经新 prompt 重放历史。** 重发既有内容保不住日志、身份与 turn 编号——构造出来的是凑巧装着同样文本的另一个会话。

**客户端轮询 `session.event` 判定结算。** 事件流缺少后裔存活性与故障偏移量；会话是否结算是服务端事实，客户端无法重构。

**加载时写入 `session/resumed` 边界事件。** 持久层已否决加载铸造的标记：它是读路径上的持久写，且不覆盖任何 fork（见[会话 end-seed 日志边界](2026-07-30-session-end-seed-log-boundary.zh.md)）。

## 影响

- TypeScript SDK 在 `DeepSeekHarness`/`HarnessClient` 上暴露 `resumeSession(sessionId)`；Python SDK 暴露 `resume_session(session_id)`。`session/wait` 是服务端方法，供 SDK 测试面与 shutdown 排序使用，非客户端便捷方法。
- 两个操作的线路结果都是 `Record<string, never>`：确认是位置性的，事实存于会话日志与 agent 状态中。
- `packages/sdk/server/tests/{resume,wait,shutdown}.spec.ts` 以真实 `Context` + `JsonlSessionPersistence` + `AgentLoop` 组合作测试，钉住恢复身份、只追加延续、故障传播、待恢复共享、shutdown 排空与拒绝路径。
- `snapshots/sdk/` 的 `session-resume` 条目对持久化夹具回放运行时重启，证明恢复历史进入 resume 后首个模型请求。
- `scripts/smoke-python-runtime.py` 对打包运行时验证重启加 resume，确认新输入前不触发模型请求，且持久化日志在 turn 1 与 2 间保持只追加。
