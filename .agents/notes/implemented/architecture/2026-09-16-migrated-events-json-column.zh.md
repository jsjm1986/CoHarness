# Agent Note: 迁移留档的事件体保持 json 类型

状态：已实现

[English](2026-09-16-migrated-events-json-column.md) | 中文

## 问题

`conversation_migrated_events` 在 `ConversationRepository.migrate` 重写会话事件体之前保存已提交的前代事件体，对应文件后端保留上一代的规则。它的 `event` 列最初建成 `jsonb`，而 `conversation_events.event` 早已由迁移 `004` 改为 `json`：事件字符串可能携带 `\u0000` 转义（指令作用域键用 NUL 分隔符拼接目录与文件名，路径本身不可能包含该字符）。`json` 原样存储该转义并在读取时还原为真实字符；`jsonb` 则直接以 `22P05 unsupported Unicode escape sequence` 拒绝。

留档拷贝在服务端执行——`INSERT ... SELECT` 从 `json` 列复制到 `jsonb` 列——因此凡是已存事件携带 `\u0000` 转义的会话，其格式迁移都在受保护的事务内失败，每次访问重试并记录 `request failed`。

## 决策

迁移 `027_migrated_events_json.sql` 通过 `USING event::text::json` 把留档列改为 `json`。存量行不可能包含 `\u0000`（jsonb 从未接受过），文本往返能逐字保留。

`ConversationRepository.serialized` 恢复为普通的 `JSON.stringify`：`json` 列本就接受该转义并在读取时还原为真实字符，使作用域键在持久化与回放之间逐字节一致。此前把 NUL 改写为字面六字符 `\u0000` 文本的尝试已回退——它存入的值与事件携带的不同，`decodeScopeKey` 在回放时找不到分隔符。

## 备选方案

**在留档拷贝中转义。** `replace(event::text, '\u0000', '\\u0000')::jsonb` 能让拷贝成功，但在留档中存入字面 `\u0000` 文本——同样的破坏性变换，只是藏进了恢复路径会读回的备份里。

**保留字面文本序列化。** 写入成功但静默改变存储值：回放解码出六字符文本而非 NUL 分隔符，每个被迁移会话的指令对账都会作用域错乱。

**读写双侧变换。** 在仓储边界互换哨兵字符会与任意用户文本中的合法哨兵碰撞，且仍然无法在 jsonb 内表示该字符。

## 后果

今后任何接收逐字事件负载的表必须使用 `json`，与迁移 `004` 及本次留档一致。jsonb 类型的元数据列（`audit_events.detail`、`conversation_interaction_responses.outcome`、provider `profile`）存在同样的 `\u0000` 限制；写入它们的负载不得携带原始事件文本。

回滚事务验证用真实的留档 `INSERT ... SELECT` 作用于含 `\u0000` 转义事件的 v0 会话，在 `json` 列下干净通过。
