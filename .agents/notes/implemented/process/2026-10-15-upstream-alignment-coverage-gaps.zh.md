# Agent Note: 上游对齐审计必须覆盖功能图、范围边界与分叉接缝契约

Status: implemented

[English](2026-10-15-upstream-alignment-coverage-gaps.md) | 中文

## Problem

alpha.2 对齐行动按文件与 lane 审计——主权 manifest 的 `--residue` 报告(`adapted`/`replaced` 包下的 stale 与未采纳文件)加分 lane Agent Note——但收口验证仍暴露出实质遗漏:插件管理页的 Creator 入口(`plugins.add.actions` 槽位加 `CreatePluginMenuItem`)、`experimental/worktree` 与 `experimental/tool-worktree` 连 `upstreamOnly` 都未进、每个新会话手势上面板复位契约的丢失、过期的生成目录,以及积压的 export-JSDoc 欠账。

上游确实发布书面变更记录,那么有记录的变更为何仍漏?因为上游的记录是**破坏性变更升级指南**,不是功能清单:`docs/upgrade-guide/` 只记录外部可感知的破坏性变更——`v0.2.1-alpha.1` 列了 19 个迁移主题,`v0.2.1-alpha.2` 连指南目录都没有。增量功能——一个新槽位、一个菜单项、一个新 experimental 包——按设计不产生指南条目。上游的功能证据散落于参考页(`docs/subsystems/slots.md` 确实记载了 `plugins.add.actions`)、包 README 与 Agent Note 之中。没有功能级的 changelog 可消费;"读发布说明"不是可用的审计输入。

## Decision

同步审计在文件清单之外采纳三个覆盖单位:

1. **功能图清单。**每个上游用户/模型可见功能按其可达面枚举——它挂载的槽位或注册点、贡献、入口、激活路径——逐项裁决(已移植 / 由具名本地机制覆盖 / 附理由拒绝),记录在当次同步的 Agent Note 中。`plugins.add.actions` 从未出现在任何文件清单上,因为本地 Plugins 页是独立实现:文件 diff 只能暴露已携带文件内的缺口。
2. **`upstreamOnly` 枚举完整性。**同步收口时将上游包树与 manifest 逐一对齐——每个上游包必须已被携带,或附理由显式拒绝。`experimental/inspector` 与 webworker 对有记录;`worktree`、`tool-worktree`、`session-search`、`session-titles`、`cot-translation`、`claude-code-mods`、`session-inspector`、`inspector-profile`、`badge-skill` 完全在 manifest 之外——是未评审,而非已拒绝。门禁校验已列条目;枚举本身是否完整是审计者的检查项。
3. **分叉接缝契约检查。**当 `replaced`/`adapted` 包的本地机制与上游不同时,审计须列出翻译中必须存活的**行为契约**,而不只是文件集合。上游的 `clearMain`/`replaceMain` 把"回到会话面"折叠进了会话导航;fork 的 `activePanelId` 面板模型保留了选择清除却丢了复位——在 `selectPanel(null)` 补齐到各手势之前,同时打断了 Plugins 页 Creator 入口、侧栏 New Session 与 Workspace 浏览器的启动动作。
4. **产品可观察验收。**面向 GUI 的移植以真实构建上的可达入口检查收尾(菜单能开、条目可用、导航落地),而不只是测试转绿——激活状态、门禁与面板机制对包级测试不可见。
5. **门禁随层运行。**doc-sync、目录重生成与 export-JSDoc 针对每个落地层运行,不再积压到收口时一次性清算。

## Alternatives considered

**继续以文件清单为唯一覆盖单位。**被证据否决:上述每一类遗漏都在一份带逐项裁决的完整文件清单之下存活——清单证明的是文件处置,不是功能可达性([client-lane 审计](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.zh.md)自行记录了此保留条款)。

**每次同步 diff 上游参考文档与 README。**部分有用——能通过 `slots.md` 暴露 `plugins.add.actions`——但无法暴露纯代码功能、分叉接缝契约丢失或 `upstreamOnly` 枚举缺口;上游文档本身描述的是机制,不是变更清单。

**以上游 Agent Note 充当功能清单。**否决其作为首要输入:note 记录的是部分变更的理由而非逐发布枚举,但在候选功能确定后仍是契约语义的最佳来源。

## Consequences

本次收口已按修正后的单位执行:Creator 入口连同其槽位契约与共享草稿路径已交付(见 [Plugins 页 Creator 入口](../feature/2026-10-15-plugins-page-creator-entry.zh.md));面板复位已在三个手势点落地;`experimental/inspector` 式 `upstreamOnly` 理由现在有了完整性检查作为常备审计步骤。未来上游同步从功能图清单与已枚举的 `upstreamOnly` 表起步;落在两者之外的包属于未评审欠账,而非沉默遗漏。[选择性同步策略](../architecture/2026-09-08-upstream-alpha2-selective-sync.zh.md)保留其按行为同步的决策;本笔记为其补齐了可审计的覆盖单位。
