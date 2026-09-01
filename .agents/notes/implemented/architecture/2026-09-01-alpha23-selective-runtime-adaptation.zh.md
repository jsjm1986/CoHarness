# Agent Note: Alpha.2 与 alpha.3 的选择性运行时适配

Status: implemented

[English](2026-09-01-alpha23-selective-runtime-adaptation.md) | 中文

## 问题

alpha.2 与 alpha.3 同时改动了多个共享的 client 和运行时路径。若照搬上游包布局，就会替换 CoHarness 对 headless 组装、Gateway 授权、输入序列化和现有 conversation façade 的所有权；若完全不处理差异，则会保留可测量的分配成本，并遗漏产品计划中描述的目录导航。

## 决策

CoHarness 在现有扩展点内采用可表达的上游行为。存在可选注册表时，`GoalService` 读取严格的 `goal` projection；headless 组装继续使用增量缓存。`AgentLoop` 发布 `turnBoundary` host projection，goal 工具授权按索引扫描不可变事件切面。projection 状态记录 Round 推进和首个回放失败，不改变 Session 格式。

`@` source 现在区分目录的落定与下钻。`InputTriggerSource` 可以发布头部，候选项可以声明 `drill`；controller 通过统一的 drill action 处理 Tab、行尾箭头和面包屑 pick。下钻文本经现有 span-CAS 输入事件写入，然后菜单重新追踪；普通文件夹 pick 仍是原子引用。既有 session-reference 编码和移动端 composer 外壳保持不变。

工具行保留原始参数文本，只在可展开行打开后调用 `formatToolBody`。Chat 与 Trajectory 保留持久的 next-step splice 链和当前领取集合；Chat 侧不再注册没有消费者的 next-turn 分类器。Queue 仍由 Host queue projection 负责。

详细领域决策继续由 [goal 笔记](../feature/2026-07-19-persisted-same-session-goal-domain.zh.md)、[输入机笔记](2026-07-25-web-input-machine-and-slash-pipeline.zh.md)、[inbox 生命周期笔记](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)、[工具行笔记](../feature/2026-07-30-web-tool-row-unified-expand-and-inspect.zh.md) 和 [依赖门禁笔记](../process/2026-09-01-alpha23-dependency-gates.zh.md) 负责。

发布范围的来源矩阵与版本记录维护在[上游选择性整合审查](2026-09-01-selective-upstream-alpha2-alpha3-sync.zh.md)中。

## 考虑过的替代方案

**整体照搬上游包。** 不采用：这会替换 CoHarness 的 Gateway/ACL、wire 错误类别、移动端 UI 所有权和 headless 依赖取舍。

**保留所有本地实现，只记录差异。** 不采用：缺失的下钻路径与产品行为冲突，折叠行的提前参数格式化也会额外复制完整载荷。

**强制所有 projection。** 不采用：headless 测试和最小 bundle 有意省略 projection 注册表；可选注册加安全的本地回退能保留这类组装。

**对完整 fork 图运行 npm 严格 peer solver。** 不采用：本地 251 个包的 peer 图会耗尽 Node 堆。布局探针通过 npm 解析 production/optional 放置，并直接检查每条合成 DSH peer 边是否保持同版本范围。

## 影响

交付行为在选定 seam 上与两个上游版本对齐，同时保留 CoHarness 的授权源和 wire 格式。目录导航、goal 读取和工具展开都在 controller、source、renderer 与回放路径获得明确覆盖。npm 布局检查有意拆分为物理依赖放置与静态 peer 范围校验；未来若缩小包图，可恢复严格 peer 安装探针而无需改变运行时决策。

## 测试

Goal、authority、input-trigger、reference、tool-row、Chat、Trajectory、依赖门禁和 npm 布局聚焦套件均通过。`pnpm run typecheck` 与定向 Oxlint 检查通过；浏览器组装快照、Windows 流程和真实提供方 e2e 仍属于发布环境检查。
