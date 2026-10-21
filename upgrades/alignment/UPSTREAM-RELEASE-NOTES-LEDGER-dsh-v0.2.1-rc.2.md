# 上游发布说明逐条对账 — dsh-v0.2.1-rc.2

## 范围与方法

- 输入:`dsh-v0.2.1-rc.2`(`687f282e8625c6b8d11ff58211a90524be2e4317`)发布说明全部条目,共 2 条。rc.1→rc.2 区间净变更 9 个提交,其中 `7d844abc875`(DeepSeek Flash 显示名追加 1017)已被同区间 `32efe36a4e4` revert,净效果仅剩临时徽标 `3c937cd0bac`。
- 证据:[rc.2 提交清单](UPSTREAM-COMMIT-INVENTORY-dsh-v0.2.1-rc.2.json)、[对齐矩阵](UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.1-rc.2.json) 395 行逐行裁决、[独立复核](UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.md)、工作区源码与 e2e 引用探测;承接 [rc.1 台账](UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-rc.1.md) 决策项 9 的 rc.2 增量裁决。
- 本地基线:`feat/upstream-sync-batch2` 栈顶(含本周期全部 rc.2 携带行,主权计数 71 tracked / 226 adapted / 57 owned / 2 replaced / 42 upstream-only)。

## 判定口径

| 代码 | 含义 |
|---|---|
| Y | 已有/本周期落地 |
| L | 有意分歧/本地替代 |

## 逐条判定

| 发布说明条目 | 判定 | 说明 |
|---|---|---|
| 适配 DeepSeek-V4.1-Flash-1017 | L | 上游净效果=`ui-deepseek-model-label-1017` 临时徽标(display-name 追加已自 revert)。裁决=不引入:fork 使用自有品牌 COHARNESS,临时徽标无对应面;模型本身经 provider 既有目录可用,无独立适配面 |
| DeepSeek Search 与 Fetch API(网页搜索设置中开启) | Y | `web/web-deepseek-api` 新包、`web` seam search/fetchProvider Volatile 化、`ui-settings-web-search` 设置卡、`web-search-deepseek` locale 条目、`deepseek-search-llm-request` 增 `thinking`、deepseek-fetch 快照场景——全部直补;`apps/web/tests` 已含 `web-search-deepseek` 插件项与 aria 快照引用 |

## 结论

2 条判定完毕:1 Y、1 L。无 N/?:rc.2 周期发布说明面与 [UPGRADE-PLAN](../plans/UPGRADE-PLAN-dsh-v0.2.1-rc.2.md)、[UPGRADE-MANIFEST](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json) 一致。具名未吸收增量(typert worker/principal 协议件、`settings/schema.ts`、`session-persistence-jsonl/catalog-migration.ts`、`llm-pi-ai/provider-data`、client/modules 发布变更接缝、ui-settings-general HostReleasePrompt)不在发布说明条目内,仍按矩阵行 notes 待后续 increment 裁决。
