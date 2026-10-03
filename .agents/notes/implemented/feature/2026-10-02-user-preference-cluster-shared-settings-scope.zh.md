# Agent Note：共享 settings scope 上的用户偏好簇

Status: implemented

[English](2026-10-02-user-preference-cluster-shared-settings-scope.md) | 中文

## 问题

上游 `dsh-v0.2.0-rc.2` 暴露了一组按用户持久化的呈现偏好——开发者工具可见性、工作步骤密度、性能详情、链接打开方式——它们构建在 `ctx.configForms` 之上，那是一个本分支从未携带的 Host settings 表单服务。缺少这些偏好时，trajectory 视图页签、agent-preset 切换器、代码 diff 卡片都只能无条件渲染，Chat 视图也没有用户可选的密度档位。整体移植 `configForms` 会与 `SettingsScope` 重复——后者已提供同样的尾序变更队列、pending-revision 栅栏与 section 镜像。

## 决策

保留 `SettingsScope` 作为偏好载体：移植偏好本身，不移植表单服务。

- `SettingsScopeBinder` 新增共享成员 `developerTools`，绑定 `ui-settings` namespace，等价于上游的 `configForms.developerTools`。`ui-settings` 的 host 侧注册 schema；消费方只读 `enabled`，不持有 scope。
- `ui-conversation` namespace 的 `ConversationSettings` section 新增 `transcriptView`（compact/standard/detailed/verbose，默认 `detailed`，旧值 `normal`/`expanded` 采用为 `detailed`）、`performanceUsage`（compact/detailed，默认 `detailed`）与 `linkOpening`（sidebar/new-tab，默认 `sidebar`）。宽松校验让未知的前向取值保持可读，而不是让整段校验失败。
- `TranscriptViewPolicy`、`PerformanceUsagePolicy`、`LinkOpeningPolicy` 沿用 `ComposerSubmissionPolicy` 的生命周期：本地先于持久写入发布；ready scope 报告只读时整体拒绝变更；采用已接受的值但不回写；随插件释放 scope 订阅。
- `presentation-policy.ts` 把模式解析成能力开关（`foldCompletedTurns`、`stepGrouping`、`liveProcessDetail`、`settledReasoningPreview`），让渲染器消费标志位而不是按模式字符串分支；verbose 停止折叠已完成 turn，compact 去掉已落定思考的预览。
- `developerTools` 门控三处：trajectory `conversation.view` 页签、`AgentPresetSeat` 切换器（禁用时 `apply` 仍会 stage 但拒绝挂载，与上游一致）、deliverables 的代码 diff 卡片——三个读取点各自消费同一个 observable。
- 链接打开在 sidebar 模式下经 `web/browser-open` bail 分发，无消费方认领时回落 `window.open`；conversation 包通过 `ctx.reflect.get('sidebarRightTabs')` 收窄到本地结构类型来探测 Browser 可用性，因为类型化依赖会产生 project-reference 环（`ui-sidebar-right` 已经消费 `ui-conversation`）。

## 考虑过但未采用的方案

**把 `ctx.configForms` 作为第二个偏好服务整体移植。** 否决：`SettingsScope` 已实现尾序写入、pending-revision 栅栏与 memory 回落；并行服务会撕裂 README 记录的设置权限模型。

**把模式字符串直接暴露给渲染器。** 否决：每个消费方都会重复推导同一张能力映射；策略表把未来新增模式限制在一行。

**为类型化 Browser 探测导入 `SidebarRightTabRegistry`。** 否决：值级依赖会引入 tsconfig project-reference 环；结构收窄在保留所读字段的类型检查的同时，让 Browser 集成保持可选。

## 影响

- `ConversationSettings` 变宽；旧版本写入的持久 section 仍然有效，新字段采用默认值。
- `registerChatNodeRenderers` 接收性能模式 observable 并注入 turn-tail 渲染器；`ChatViewInjected` 与 `ChatNodeOwnerProps` 携带 presentation 策略。
- 共享测试运行时的 `stubSettingsScope` 持有 `developerTools` 成员，各 spec 的 stub 仍是一行。
- 装配中没有 Browser 标签类型时链接行不渲染任何内容，偏好不会把用户困在不可用的路由上。

## 验证

`preferences-policies.client.spec.ts` 覆盖默认值、先于写入的本地发布、Host 采用、旧值映射与 presentation-policy 表。`settings-rows.client.spec.tsx` 挂载全部三个设置行，含只读与无 Browser 分支。`apply-inject.client.spec.tsx` 驱动 `openExternalLink` 走完 bail/新标签页分派。`chat-view`、`reasoning-row`、`stats-pills`、`host` 各 spec 覆盖折叠、预览门控、紧凑统计与 schema 默认值。
