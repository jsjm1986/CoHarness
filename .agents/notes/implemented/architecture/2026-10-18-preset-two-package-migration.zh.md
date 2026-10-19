# Agent Note:preset 双包迁移至声明模型

Status: implemented

[English](2026-10-18-preset-two-package-migration.md) | 中文

## 问题

上游 rc.2 将 `agent-presets` 拆分为 `agent-preset`(注册 `PresetDefinition` 的声明式插件)与 `agent-preset-registry`(支撑 `ctx.agentPresets.register` 的名册服务,带代际生命周期与 `acquireScope`)。Fork 的 `agent-presets` 是更丰富的文件发现模型——roots、trust、authoring/copy/remove、Typert Remote 端点、inventory、realm 作用域环境、以及与持久化选择绑定的 standing 代际。Fork 如何在不丢弃全部 fork 消费面所依赖的文件模型的前提下采纳上游声明接缝?

## 决策

合并而非替换。包拆分整体采纳(`agent-presets` 改名为 `agent-preset-registry`,新增 `agent-preset`),同时 fork 的文件发现注册表保留为语义核心,并叠加获取上游声明层:

- **`AgentPresetRegistry.register(definition)`** 校验 id、拒绝重复、创建 `DeclaredRecord`,并返回异步 disposer。声明式代际是按 realm 键控的作用域,通过 `acquireScope` 与子 agent join 保活;注销将其标记退役,`collectDeclared` 仅在已退役且无使用者时释放。
- **双源名册**——`list()` 先输出声明行,再输出沿用既有 first-root/id 遮蔽规则的文件行;`resolve` 与 `resolveMountable` 检索合并名册。声明式 preset 没有 `path`:`FileAgentPreset` 收窄纯文件操作,`read` 序列化存储的 `PresetDefinition`,`copy`/`remove`/`openDocument` 以 `PresetNotWritableError` 拒绝声明式 preset。
- **`swap`/`recompose`** 在文件 standing 键之外识别声明代际键,并保留当前 realm。
- **`compositionInventory`/`inspectCompositions`** 通过 `definitionComposition` 报告声明定义、通过 `fileComposition` 报告文件 preset,inspection 上提供 `modules`/`leakedServices`。
- **`agent-preset`** 按上游形态携带:`Config` 即 `PresetDefinition` 的 `Service` 插件,`EntryGroup.key` 在激活前保留子表达式,附带 creator skills(`agent-experience` 通过 `.agents/skills` 符号链接进入仓库 skill 树)。
- **`skill-filesystem`** 通过 `realpath` 规范化已加载 skill 路径,与上游一致,使仓库级 skill 符号链接解析到包目标。

`agent-presets` settings 命名空间保持不变——它是持久化用户键,而非包标识。

## 已考虑的替代方案

- **用上游的纯声明注册表替换文件模型**——否决:将删除 root 发现、trust 治理、用户 authoring、Typert Remote 面、inventory 与 realm 环境,这些均有 fork 消费方。
- **仅携带 `agent-preset` 并保留纯文件注册表**——否决:上游 `ctx.agentPresets.register` 接缝正是包拆分存在的理由;没有它声明式 preset 无处安放,迁移沦为表面文章。
- **随包名重命名 settings 命名空间**——否决:`agent-presets` 是持久化的面向用户键;重命名会使已存选择成为孤儿,且毫无对齐收益。

## 后果

消费方对改名后的包与 `AgentPresetRegistry` 编译;`PresetDefinition` 成为公开、可序列化的组合词汇。声明式 preset 参与 inventory 与 swap,但在构造上被排除于文件系统 authoring 面之外。`verify-upstream-sovereignty` 与 rc.2 对齐矩阵将 `preset/agent-preset` 记为 `tracked`、`preset/agent-preset-registry` 记为 `adapted`,替换原先的 deferred-P5 簿记。

## 验证

- `npx vitest run packages/preset/agent-preset-registry`——11 个文件 181 项测试通过,含 `declared.spec.ts` 生命周期覆盖(join、bind、retain、retire、scope 释放)。
- `npx vitest run packages/preset/agent-preset`——上游 skill 加载 spec 在 `realpath` 规范化加载器下通过。
- `pnpm exec tsc -b packages/host` 与 preset 包 typecheck 在 `exactOptionalPropertyTypes` 下通过(`FileAgentPreset` 收窄后)。
