# Agent Note: 上游展示行对应的实验性功能 bundle

状态: 已实现

[English](2026-10-18-experimental-feature-bundles.md) | 中文

## 问题

上游 rc.2 提供五个轻量级按需启用的 bundle 包，使其 plugin-manager 展示界面为每项能力提供一个可切换的行:持久终端、跟随会话的标题、DSH badge 技能、Ralph 循环和会话搜索。fork 以不同方式组合相同的能力——其中几项已在 `dsh-base` 中以禁用状态停靠——因此展示界面没有可切换的行,直接照搬上游补丁会插入重复的行 id。

## 决策

每个上游 bundle 对应 `packages/experimental/` 下的一个 fork 包,保持 fork 的管理模型:一个 `cordis.patch.yml`、双语 locale 元数据、上游的 `icon.svg`、空的 `src/index.ts`、补丁规范以及双语 README。五个 bundle 都注册在 [`packages/boot/app-boot/src/profile.ts`](../../../../packages/boot/app-boot/src/profile.ts) 的 `OPTIONAL_BUNDLES` 中,plugin-manager 展示界面据此列出它们;启用某个 bundle 会在已发布的 profile 之上应用其补丁,且没有任何一个进入默认组合。

补丁内容遵循上游,在行已存在时按 fork 方式定位:

- `terminal-bundle` 复制上游隔离的 `optional-persistent-terminals` 组(`terminals: true`),包含终端注册表、bash/pwsh 后端和 `tool-terminal`。
- `session-titles-bundle` 禁用已有的 `session-title-llm` 行,并插入带有上游调优配置的 `dsh-session-title-all-prompts-llm`(targetWords 5、targetCjkCharacters 10、maxInputBytes 4096、maxOutputTokens 64、timeoutMs 60000)。
- `badge-skill-bundle` 启用已有的 `skill-badge` 行,而不是插入重复行。
- `ralph-bundle` 插入上游隔离的 `optional-ralph` 组(`workflowEngine: true`),包含 `workflow-ptc`(provider `spawn`)和 `tool-ralph`(subagentProvider `spawn`、maxRounds 64)。
- `session-search` 插入隔离的 `optional-session-search` 组(`sessionQuery: true`),包含在首次搜索时打开的内存 SQLite 索引以及 `tool-session-query`;已发布的 `session-query-sqlite` 行保持 `openAt: never`。

每个 bundle 的 `package.json` 将其组合的行插件声明为依赖,导出 `cordis.patch.yml` 和 `locale/*.json`,携带 `dsh.bundle.patch`,并且是 `apps/cli` 的运行时依赖。上游同步清单将五个包全部归类为 `adapted`,以本笔记为证据。

## 曾考虑的替代方案

- **照搬上游补丁**在 fork 已组合该行的情况下被否决:`applyEntryPatches` 要么因重复 id 冲突,要么留下两个激活的 provider;针对 id 的覆写在 fork 的停靠行上表达了相同的意图。
- **修改已发布的组合**被否决:按需启用的 bundle 模型保持默认 profile 逐字节不变,同时为展示界面提供开关。

## 测试

每个包的 `tests/patch.spec.ts` 解析其 `cordis.patch.yml` 并断言行结构。`scripts/optional-bundles.spec.ts` 将每个已注册的可选 bundle 应用到已发布的 Web 层之上,并拒绝被跳过的补丁、重复的顶层 id 以及无效的 id 定向覆写——覆盖全部五个 bundle。`verify-default-product-isolation` 确认没有实验性包进入默认运行时依赖或已发布组合;`verify-upstream-sovereignty` 校验清单条目。

## 后果

- 启用 bundle 是按 profile 生效且可逆的;已发布的默认值不变。
- `docs/config-catalog.md` 将 bundle 列在 library 区段(空的 `src/index.ts`、无插件导出),与已有的 `schedule-bundle`/`plugin-market-bundle`/`agent-team-profile`/`voice-input-bundle` 条目一致。
- `ralph-bundle` 和 `badge-skill-bundle` 切换的行在已发布组合中同样处于停靠状态;`ralph-bundle` 中的隔离组使 `workflowEngine`/`terminals`/`sessionQuery` 服务作用域与上游保持一致。
