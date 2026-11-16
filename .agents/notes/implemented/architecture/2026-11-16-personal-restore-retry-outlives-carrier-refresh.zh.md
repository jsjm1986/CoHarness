# Agent Note: 已保存选择的恢复重试要比承载它的 refresh 活得更久

Status: implemented

[English](2026-11-16-personal-restore-retry-outlives-carrier-refresh.md) | 中文

## 问题

[personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) 在目录落地后恢复持久化的个人电脑选择。注意力事件（`online`/`focus`）通过 `refresh(retrySelection = true)` 在新元数据到达时重试挂起的恢复——即 `personal-navigation-resume` 场景所走的恢复路径。

`refresh(retrySelection)` 曾是随调用生效的参数，只由该调用启动的 flight 应用，因此 [revisit 合流笔记](../bug-fix/2026-11-09-personal-directory-revisit-coalescing.zh.md)在 `focus` 与 `restoreSelection` 修掉的同一事件丢失族，在 `refresh` 内部仍有残留：

- 在飞的 `work` 使 `refresh(true)` 直接返回既有 promise；该 flight 应用的是 `retrySelection = false`。
- `deploymentContext.subscribe` 在每次发布时中止在飞请求并以*普通* `refresh()` 重启——被中止的 flight 在 `throwIfAborted` 处抛出、被 catch 吞掉，替代 flight 同样应用 `retrySelection = false`。

两条路径下 `restoreSelection(true)` 都不会运行：挂起的会话 intent 永远停留在 `unavailable`，没有任何后续自动触发——即 CI 中 intent 编辑器等待隐藏直至超时的失败形态。

## 决策

重试请求是挂起的意图，不是调用参数。`refresh(true)` 在任何提前返回之前先记录 `selectionRetry = true`；下一次发布目录的 refresh 通过 `restoreSelection(selectionRetry)` 应用并消费它。被中止、被取代、被丢弃和被策略跳过的 refresh 因此都无法丢失这次重试——与 `retryQueued`（在飞恢复）和 `revisitQueued`（在飞 revisit）同一合流惯例。

该标志随账户作用域（`identity()`）重置，因为排队中的重试属于它所恢复的那个账户的选择。

## 备选方案

**只在 `focus` 的 flight 内重试。** 否决：丢弃发生在 `focus` 之下的 `refresh` 内部；任何其他 `refresh(true)` 调用者（hostDescription、账户验证）承载同样的意图。

**在首次落地尝试时无条件清除。** 否决：被中止的 carrier 永远到不了 `restoreSelection`；在那里消费标志会重现丢失。

## 后果

`online`/`focus` 触发的重试现在会落在下一个发布目录元数据的 refresh 上，无论此前有多少 flight 被取代。被消费后仍失败的重试让 intent 保持 `unavailable` 等待用户显式重试——未新增重试循环，`restoreSelection` 的守卫（recovery、已中止信号、在飞 `restoreWork`、intent `active` 匹配）仍是唯一裁决者。

## 验证

`personal-directory.client.spec.ts` 新增用例：让重试 refresh 停在一个被占用的 catalog 响应上，在飞行中重发布 `deploymentContext`（中止 + 普通重启），观察第二次 `ensureSession` 调用提交已保存会话。已做红绿验证：无此标志时该 spec 失败。`personal-navigation-resume.e2e.ts` 覆盖浏览器路径。
