# Agent Note: 会话历史召回工具、CJK 全文搜索与项目可读 ACL

Status: implemented

[English](2026-10-18-session-history-recall-tools.md) | 中文

## Problem

`dsh-tool-session-query` 早已提供完整的工作区授权搜索、跟踪与事件读取工具，但三处缺口使会话历史召回始终到不了模型：`standard` 代理预设从未挂载该包；SQLite FTS5 `unicode61` tokenizer 把整段汉字当作一个 token，中文查询完全无法命中；工作区 `cwd` 相等是唯一授权规则——在共享项目工作区中挂载这些工具会让任一成员搜到其他成员同 `cwd` 的会话。

## Decision

在 `standard` 预设中挂载 `tool-session-query`；`sessionQuery` 服务与其 SQLite 索引仍留在宿主组合中，个人工作区部署无需新增表面即可获得召回能力。

[sanitizeFtsText](../../../../packages/session-query/session-query-sqlite/src/query.ts)——索引文档与 MATCH 查询共用的唯一规范化器——现在会在每对汉字相邻字符之间插入保留的零宽空格（`U+200B`）。`unicode61` 将其视为分隔符，于是每个 CJK 字符成为独立 token，普通短语匹配由此获得任意长度的子串语义：`记忆` 可匹配 `记忆系统` 内部，`试A版` 等混写区段也在两侧拆分。规范化高亮片段时该字符会被剥离，呈现文本保持原样。非汉字区段仍是 token/短语召回而非任意子串召回。

`dsh-tool-session-query` 的授权在工作区相等之上叠加项目可读性。新增的 `readableSet` 助手仅在 `collaboration` 服务挂载时调用 `collaboration.capture().readableSessionIds()`，与 session-reference 惯例一致；服务缺位时（个人工作区）`cwd` 规则即完整规则，行为不变。`authorizeTarget` 拒绝不可读目标，`authorizeSessionIds` 将请求的父 id 与可读集合求交，会话搜索按页批量过滤命中项，跟踪投影为全部祖先与后代记录预取一次集合，使不可读节点沿用既有的无 id 边界/子树标记。读取后复核仍校验观测记录是否为已授权目标。

## Consequences

- `standard` 预设挂载五个只读会话工具：每次模型请求增加五个 schema 与固定召回指引。
- 每份索引文档与查询为每对汉字相邻字符多付一个 `U+200B`；snippet 归一化会剥离该字符，呈现文本不含它。
- `session_handoff` 在后续变更中加入；本 note 只覆盖五个搜索、血缘与读取工具。

## Alternatives considered

**汉字 bigram 索引（ZCode 方案）。** 将汉字区段展开为 bigram 只能回答两字查询，覆盖不了三字及以上的子串和汉英混写区段。按字符拆分加短语匹配可统一覆盖任意长度。

**`trigram` tokenizer。** 要求查询至少三个字符，`记忆` 仍无法命中；实施前已用 SQLite 实测排除。

**在 `session-query-sqlite` 内做 ACL。** 服务契约是语料而非参与者；授权属于执行读取的操作层，即工具层。提供方保持参与者无关。

## Verification

`session-query-sqlite` 规格覆盖两到四字中文子串、`试A版` 混写区段、孤立单汉字、无连接符泄漏的片段还原以及不命中空集。`tool-session-query` 规格覆盖 ACL 遮蔽的搜索命中、四个目标工具对不可读目标的拒绝、扣留标题读取的不可读子树遮蔽，以及不可读父 id 过滤。`pnpm vitest run packages/session-query/tool-session-query packages/session-query/session-query-sqlite` 通过 181 项测试，改动源码 100% 覆盖；`verify-cordis-config` 接受新增预设行。
