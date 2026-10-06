# Agent Note: 英文界面文案审查修正

Status: implemented

[English](2026-10-04-english-ui-copy-review-corrections.md) | 中文

## 问题

此前对管理端（`gateway/admin-ui/src/**/*.copy.ts`、`plugins/locales.ts`）与客户端（`packages/*/src/client/locales.ts`）抽取的双语词典只做了键位、占位符与残留中文的机检，从未做过英文忠实度审查。三个域的审查发现了真实缺陷：事实性误译（`宿主目录` → `Home directory`、`未正常退出` → `no exit code`、终端权限拒绝文案中 `或` → `and`）、语法残缺（`the draft still edits`、`Restore inherited`、`Unstopped instances`、`Requested opening containing folder`）、丢义（`暂不可用`、`之后不再询问`、`不重复计入`、`{error}` 后裸接一句），以及跨文件术语漂移（`资格`、`例外`、`元`、`状态`、`永久清理`、`Provider`）。

## 决策

在原位修正 `en` 条目；`zh` 仍是事实来源，只改一处全语料笔误（`运行回合` → `运行会话`，与全库 `会话` 用法一致）。术语规则全库统一：`zh` 写拉丁产品名词 `Provider` 处英文保持大写（受管 Provider 实体），`提供方` 译为小写 `provider`；`资格` → `qualification`、`例外` → `override`、`元` → `CNY`、`永久清理` → `purge`、裸 `状态` 列标签 → `Status`、`读取` → `Reading`/`read`。有意的域内区分保留：`会话` → `session` 对 `对话` → `conversation`、`代次` → `generation` 对 `revision`、`来源` → `Origin` 对 `Source`；产品命名（`reminder`、`Session`、`Workspace`、`Host`、`Agent`、`ralph`）维持既定大小写。

## 文件

- `gateway/admin-ui/src/pages/*.copy.ts`（19）、`gateway/admin-ui/src/components/*.copy.ts`（8）、`gateway/admin-ui/src/plugins/locales.ts`——误译、语法、丢义与术语统一。
- `packages/client/*/src/client/locales.ts`、`packages/extensions/ui-cordis/src/client/locales.ts`、`packages/experimental/*/src/client/locales.ts`、`packages/session-query/session-log-export`——同类问题，另有 `WorkSpace` 拼写、`或`→`and` 逻辑反转、`kind.*` 全大写族补全。

## 考虑过的替代方案

**`provider` 一律小写。** `zh` 自身以拉丁名词 `Provider` 指受管实体、以 `提供方` 指泛称；镜像这一区分保留了在线可见的产品名，故小写 `provider` 留给 `提供方`。

**改写 `zh` 以迁就英文。** `zh` 是带着断言上线的源文本；只有 `回合` 这一处因破坏全库 `会话` 术语而修正，其余分歧均由英文侧修复承担。

**维持一切既成产品大小写。** 一致的产品名词（`Workspace`、`Host`、`Agent`）保持原样，但孤立拼写 `WorkSpace` 与全大写徽标族中混入的 `kind.message`/`kind.sub` 属缺陷而非命名，已修为 `Workspace`、`MESSAGE`、`SUB`。

## 影响

英文语言态下的管理端与客户端界面呈现事实正确、语法合规的文案；`verify-client-ui-i18n`、`locale-dictionary-parity`、admin-ui 单测与 hygiene 在修正后的词典上全部通过。新增文案必须经 `zh` 键进入并配审校过的 `en` 条目；复审应把「同一中文词两种英文」与 `暂`/`仅`/`之后不再` 类限定词丢失视为高发缺陷类别。
