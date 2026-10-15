# Agent Note: 上游对齐审计必须覆盖功能图、范围边界与分叉接缝契约

Status: implemented

[English](2026-10-15-upstream-alignment-coverage-gaps.md) | 中文

## Problem

alpha.2 对齐行动按文件与 lane 审计——主权 manifest 的 `--residue` 报告(`adapted`/`replaced` 包下的 stale 与未采纳文件)加分 lane Agent Note——但收口验证仍暴露出实质遗漏:插件管理页的 Creator 入口(`plugins.add.actions` 槽位加 `CreatePluginMenuItem`)、`experimental/worktree` 与 `experimental/tool-worktree` 连 `upstreamOnly` 都未进、每个新会话手势上面板复位契约的丢失、过期的生成目录,以及积压的 export-JSDoc 欠账。

上游确实发布书面变更记录,那么有记录的变更为何仍漏?因为审计从未消费承载它们的渠道,而它消费的渠道又把功能项延后了。上游在 **GitHub Releases** 上发布完整的双语逐发布功能 changelog——`dsh-v0.2.1-alpha.1` 逐字写明了插件管理页的 Creator 入口("插件管理页新增「让 Agent 创建插件」入口"),`dsh-v0.2.1-alpha.2` 写明了 Git Worktrees、思考翻译、`working_directory` 与 Claude Code/Codex 安装入口。行动的书面输入是仓库内的 `docs/upgrade-guide/`(只记破坏性变更:alpha.1 有 19 条,alpha.2 没有目录)与 `upgrades/alignment/` 下的提交审计;后者逐条判定 `fix(` 提交(rc.1 为 577 条,alpha.2 约 272 条),功能提交则记为仍在落账,rc.1 对齐矩阵 359 行中有 322 行停留在 `pending-cumulative-source-review`。没有任何一步把发布说明的功能列表映射到已交付的界面上,增量功能因此一直停在没有门禁约束的待定状态。本页列出的每项遗漏,都早已写在一个我们没有读的来源里。

## Decision

同步审计在文件清单之外采纳这些覆盖单位:

1. **发布说明先行对账。**GitHub Releases 的 changelog 是逐发布功能清单的权威来源。每一条目——新增功能、问题修复、体验优化与其他变更——逐项裁决(已移植 / 由具名本地机制覆盖 / 附理由拒绝 / 不适用于本产品),记录在当次同步的 Agent Note 中;并且对旧基线到新基线之间的**每一个**发布的说明做对账,而不只是目标 tag 的。Creator 入口在 `dsh-v0.2.1-alpha.1` 的说明中就已列出并存活进 alpha.2 的代码树,所以 alpha.1→alpha.2 的增量审计永远不会重新浮现它。
2. **功能图清单。**每个对账条目追溯到其可达面——它挂载的槽位或注册点、贡献、入口、激活路径。`plugins.add.actions` 从未出现在任何文件清单上,因为本地 Plugins 页是独立实现:文件 diff 只能暴露已携带文件内的缺口。
3. **`upstreamOnly` 枚举完整性。**同步收口时将上游包树与 manifest 逐一对齐——每个上游包必须已被携带,或附理由显式拒绝。`experimental/inspector` 与 webworker 对附有理由;worktree、cot-translation、session-inspector、claude-code-mods、session-search 各族只出现在 alpha.2 审计的散文观望清单里,`session-titles-bundle`、`inspector-profile`、`badge-skill-bundle` 则在任何记录中都未被点名。它们都没有进入 manifest,因此没有任何门禁或台账追踪它们。门禁校验已列条目;枚举本身是否完整是审计者的检查项。
4. **分叉接缝契约检查。**当 `replaced`/`adapted` 包的本地机制与上游不同时,审计须列出翻译中必须存活的**行为契约**,而不只是文件集合。上游的 `clearMain`/`replaceMain` 把"回到会话面"折叠进了会话导航;fork 的 `activePanelId` 面板模型保留了选择清除却丢了复位——在 `selectPanel(null)` 补齐到各手势之前,同时打断了 Plugins 页 Creator 入口、侧栏 New Session 与 Workspace 浏览器的启动动作。
5. **产品可观察验收。**面向 GUI 的移植以真实构建上的可达入口检查收尾(菜单能开、条目可用、导航落地),而不只是测试转绿——激活状态、门禁与面板机制对包级测试不可见。
6. **门禁随层运行。**doc-sync、目录重生成与 export-JSDoc 针对每个落地层运行,不再积压到收口时一次性清算。

## Alternatives considered

**继续以文件清单为唯一覆盖单位。**被证据否决:上述每一类遗漏都在一份带逐项裁决的完整文件清单之下存活——清单证明的是文件处置,不是功能可达性([client-lane 审计](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.zh.md)自行记录了此保留条款)。

**每次同步 diff 上游参考文档与 README。**部分有用——能通过 `slots.md` 暴露 `plugins.add.actions`——但无法暴露纯代码功能、分叉接缝契约丢失或 `upstreamOnly` 枚举缺口;上游文档本身描述的是机制,不是变更清单。

**只对目标 tag 的发布说明对账。**否决:更早发布中宣布的功能会存活进后续代码树而不在任何增量中重现——Creator 入口在 alpha.1 宣布,在 alpha.2 已是存活代码。对账必须覆盖自上次同步基线以来的每一个发布。

**以上游 Agent Note 充当功能清单。**否决其作为首要输入:note 记录的是部分变更的理由而非逐发布枚举,但在候选功能确定后仍是契约语义的最佳来源。

## Consequences

本次收口已按修正后的单位执行:Creator 入口连同其槽位契约与共享草稿路径已交付(见 [Plugins 页 Creator 入口](../feature/2026-10-15-plugins-page-creator-entry.zh.md));面板复位已在三个手势点落地;`experimental/inspector` 式 `upstreamOnly` 理由现在有了完整性检查作为常备审计步骤。未来上游同步从对账上次基线以来每个发布的 changelog 起步,再把每个条目追溯进功能图清单与已枚举的 `upstreamOnly` 表;落在三者之外的包与功能属于未评审欠账,而非沉默遗漏。[选择性同步策略](../architecture/2026-09-08-upstream-alpha2-selective-sync.zh.md)保留其按行为同步的决策;本笔记为其补齐了可审计的覆盖单位。
