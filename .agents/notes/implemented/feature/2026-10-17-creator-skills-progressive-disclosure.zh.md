# Agent Note：creator 技能在 pruner 阈值之下采用渐进披露

Status: implemented

[English](2026-10-17-creator-skills-progressive-disclosure.md) | 中文

## 问题

`cordis` preset 的 `skills/` 目录经 `dsh-skill-filesystem` 挂载进每个 creator 会话。每个 `SKILL.md` 正文原样渲染为一次 `skill` 工具结果，而标准 preset 的 tool-result pruner 会裁切超过 `thresholdChars: 8192` 码点的结果。单体编写指南要么尾部被裁切，要么把低频细节塞进每个加载它的会话。

## 决策

随发行附带的 creator skill 拆分为短流程与按需引用。`cordis-plugin-development/SKILL.md` 只保留编写循环与路由表；`references/` 承载 host 插件、UI 插件、MCP bundle 与验证细节，`templates/` 承载可复制的 bundle 骨架。`editing-cordis-compositions` 把原生产品子代理的操作说明移入 `references/native-subagents.md`。`cordis-composition-reference/references/packages.md` 由 `scripts/gen-plugin-packages.ts` 从工作区生成，并经 `doc-sync` 中的 `verify-plugin-packages` 做新鲜度校验。

`apps/cli/tests/creator-skills.spec.ts` 渲染每个随发行附带的 `SKILL.md`，断言结果低于 pruner 阈值、每个被引用的 `references/` 或 `templates/` 路径存在、每个模板的 `package.json` 与 Cordis patch 经 `entryListSchema` 可解析、模板 JavaScript 通过 `node --check`。该 spec 还拒绝禁止阅读 DSH 包源码的 skill 文案——文档的顺序是检查结果、README、然后 `lib/`——以及经 shell 命令搬运 skill 文件的文案，因为 Desktop 把该目录封装进只有 Host 进程能打开的 `app.asar`。

检查路径本身也是此特性的一部分：`cordis_inspect_query` 的 `Config.listConfigs` 经 `Context.pluginPackages` 报告每个 entry 的 `packageDir`，而当启动器提供了 profile 上下文时，`dsh-shell-env` 向每次模型 shell 调用发布 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`。

## 曾考虑的替代方案

**一份完整的编写文档。** 它已超出 pruner 阈值，无论如何尾部都会被裁掉；目录加按需读取才能让加载的正文保持完整。

**按插件生成文档。** `Config.listConfigs` 已暴露已安装包的目录；把包 README 复制进生成的 skill 文件会为同一事实制造第二个归属。

## 后果

向随发行的 skill 增加引用文件或模板无需改动代码，但 spec 会把每个被引用路径绑定到真实文件。把正文推过阈值的 skill 编辑会让 spec 失败，而不是在生产中静默截断。内嵌 skill 正文的快照场景（`skill-load`、`skill-tool-row`）在 skill 文本变更时必须刷新。
