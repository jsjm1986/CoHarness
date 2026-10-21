# Agent Note：经 fork 接缝移植思考过程机器翻译

状态：已实现

[English](2026-10-18-cot-translation-port.md) | 中文

## 问题

上游 rc.2 携带面向展开推理内容的机器翻译：`translator` 服务（匿名翻译端点加可选原生 Flash，结果可复用进 Session）、`client-ui-cot-translation`（翻译展开的思考内容，同时保留原文与已存结果），以及 `cot-translation-bundle` 选用补丁（`provider: bing`、`targetLanguage: auto`）。fork 此前因其"需要被排除的 deepseek-account 提供方面"而延期；插件管理橱窗将该 bundle 列为一行，该行需要真实内容。

## 决策

三个包全部按上游包名移植进 `packages/experimental/`，`locale/*.json` 双语与 `icon.svg` 逐字节沿用上游。账号面阻塞不成立：translator 默认提供方走匿名 HTTP 端点（bundle 补丁中 `provider: bing`），该功能不依赖被排除的账号链——账号链只是若干可选提供方之一。

`client-ui-cot-translation` 挂载在 fork 自有会话面上（其 client 半侧引入 `dsh-client-ui-conversation`），不引入上游 `ui-chat`。`cot-translation-bundle` 已注册进 `OPTIONAL_BUNDLES`（供橱窗开关）与 `apps/cli` 依赖；不进入任何出厂默认组成。

## 已考虑的替代方案

- **维持延期**被否决：阻塞只是可选提供方面之一，并非硬依赖；bundle 默认即用匿名提供方。
- **改接 fork 的 `llm` 接缝做翻译**本轮否决：上游提供方契约已抽象端点，把推理文本走模型服务会把翻译与生成混为一谈。

## 测试

各包规格随源码一并移植（`translator` 13 份、`client-ui-cot-translation` 7 份、`cot-translation-bundle` patch 规格）；`tsc --noEmit` 干净。原移植代理中断后，注册由收尾工作直接补齐。

## 后果

思维链翻译默认走匿名端点，因此该能力不依赖账号即可随包发布；可选的 Flash 提供方保留给有配置的部署。bundle 为可选开启——在 profile 启用之前，出厂默认组成不变。
