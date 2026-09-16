# Agent Note: 对话内容宽度携带独立的持久化占满标志

Status: implemented

[English](2026-09-16-chat-full-width-preference.md) | 中文

## Problem

`CHAT_CONTENT_WIDTH_RANGE` 把对话内容列钳制在 560–1080px——这是设置滑块、拖拽手柄、持久化设置 schema 与 Gateway 账户偏好校验器共享的可读性边界。在宽窗格中，列宽停止增长而两侧留白持续扩大。用户需要一种让对话内容铺满窗格的方式，同时不为所有人放宽像素边界。仅靠宽度值无法表达占满意图：数值区间内的哨兵值会与浏览器和 Gateway 两侧的范围校验冲突，区间外的哨兵值又会丢失用户记住的像素宽度。

## Decision

`ConversationSettings` 新增独立的持久化布尔字段 `chatFullWidth`，默认 `false`。占满开启时像素 `chatContentWidth` 仍保留在存储中，关闭占满即可恢复原宽度，无需第二份偏好。占满时对话内容按 `calc(100% - 2 × 侧隙)` 渲染，保持与输入框的边距关系；设置行禁用滑块并显示占满状态而非数值。

占满是模式而非宽度。任何显式像素选择——滑块、拖拽手柄或键盘步进——都会清除 `chatFullWidth`，并通过同一 scope 持久化两次变更。拖拽手柄在占满态以实测渲染宽度作为拖拽起点，退出占满时从用户所见宽度延续，而非跳回陈旧的存储值。

该字段沿既有账户偏好链路端到端传输：zod 设置 schema、display-settings store 的待写对账、设置行复选框、`AccountPreferenceMutation` 字段白名单与 `string | number | boolean` 值联合、Gateway `normalizeAccountPreferenceMutation` 布尔校验、迁移 `026_chat_full_width.sql` 添加的 `harness.user_preferences.chat_full_width` 列，以及 PostgreSQL 行初始化时使用的 legacy `settings.yaml` 读取器。值视图将该字段默认为 `false`；列为 null 时 overrides 层省略它。

## Alternatives considered

**用哨兵宽度编码占满。** 数值区间内外的魔法数把两种意图混入一个字段，迫使客户端 schema 与 Gateway 校验器都为它特判，还会覆盖用户退出占满时期望找回的像素宽度。

**占满仅作会话级 UI 状态。** 瞬态开关无法随账户跨浏览器与运行时生效，而这正是其他显示偏好通过账户 scope 已兑现的契约。

**改为提高 `CHAT_CONTENT_WIDTH_RANGE.max`。** 放宽像素边界会移除所有用户的可读性上限，且仍无法表达"窗格多宽就铺多宽"；占满是可选的逃逸口，而非新默认值。

## Consequences

账户偏好链路的每一层都必须接受新字段，否则写入会失败关闭。该特性的首个版本恰好证明了这一点：Gateway 字段白名单与 PostgreSQL 列落后于浏览器 UI，`PATCH /account/api/preferences` 拒绝 `chatFullWidth`，共享 `ui-conversation` 写入状态的所有行都渲染保存错误。因此该字段在每个验收边界都带覆盖——`gateway/tests/account-preferences.spec.ts` 的路由级接受/拒绝、connection spec 的传输解码与 legacy 默认值、account-scope spec 的变更类型、PostgreSQL 服务测试的列路径。

占满模式仅在账户主动选择时让对话内容超出文档化的可读性边界；像素范围、其 Gateway 校验与拖拽手柄的钳制对显式宽度保持不变。
