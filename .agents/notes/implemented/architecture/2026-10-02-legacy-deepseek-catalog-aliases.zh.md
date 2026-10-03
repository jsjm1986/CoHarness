# Agent Note：pi-ai 0.87 改名后保留旧版 deepseek catalog id

Status: implemented

[English](2026-10-02-legacy-deepseek-catalog-aliases.md) | 中文

## 问题

pi-ai 0.87.1 把 `deepseek-v4-flash` 改名为 `deepseek-flash`（DeepSeek V4.1 Flash），并从内置 catalog 中移除了 `deepseek-v4-flash-vision-exp`。本部署的会话日志、settings 文档、组合 profile 与 snapshot fixture 命名的是 0.85 时代的 id——逾千个已提交文件，其中包括不可改写的不可变会话日志代次。若不保留这些 id，catalog 路由会把它们解析为空，流式调用不产生任何分片。

## 决策

`catalogModels` 把 `LEGACY_MODEL_ENTRIES` 合并进内置 catalog 映射：每个旧 id 对应一条 `Model<Api>` 条目，原样携带 0.85 时代的元数据——包括线上 `id`——使请求、回放校验与选择器列表的行为与升级前完全一致。若内置 catalog 重新收录某个 id，对应别名条目被跳过，因此该表会随 pi-ai 恢复命名而自然缩小。

## 曾考虑的替代方案

**在 pi-ai patch 文件中改写 `deepseek.json`。** 否决：该数据文件是单行压缩 JSON，补丁块会钉住整个 catalog blob，每次上游刷新 catalog 都会失配；fork 侧表格用两条可评审的条目表达同一事实。

**把 fork 的 id 统一改成 `deepseek-flash`。** 否决：已提交的会话代次不可变，线上 settings 文档也使用旧 id，改名永远无法完成。

**以旧 id 克隆继任模型的元数据。** 否决：V4.1 的 image 输入与更高定价会静默夸大 `deepseek-v4-flash` 请求实际获得的能力；0.85 元数据是该线上 id 最后一份经过验证的约定。

## 影响

- `deepseek` catalog 路由比内置注册表多列出两个条目；与 `getBuiltinModels` 对比的断言显式计入它们。
- 若某次 pi-ai 升级重新收录其中任一 id，对应表项即变为空操作，可删除。

## 验证

`adapter.spec.ts` 通过别名条目流式调用 `deepseek-v4-flash`；`catalog.spec.ts` 与 `discovery.spec.ts` 固定别名在列表与发现输出中的存在。
