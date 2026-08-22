# Agent Note: 移除内测声明

Status: implemented

[English](2026-08-18-remove-internal-testing-notice.md) | 中文

## 问题

GUI 首次启动仍会先弹出版本化的「内测声明」弹窗（`welcome-notice`），再进入 DeepSeek 凭据步骤。该插页复述 0.1 仍是面向 Harness 开发者的内部测试版本。产品不再希望这条声明出现在首次使用路径上。

## 决策

从组装后的产品中删除 `welcome-notice` 引导步骤。`ui-settings-models` 不再注册它；组件、确认 store、文案所有者、locale 键，以及对应的单元、store 与浏览器测试均已删除。剩余的 `deepseek-official` 步骤仍使用 `OnboardingModal`，且仅在没有任何可用提供方时出现。

保留 Host 的 `ui-onboarding` namespace 及其 `welcomeNoticeVersion` 字段，使既有 `settings.yaml` 文档继续有效。GUI 不读写该字段。这与此前[全屏声明移除](2026-08-13-remove-first-run-beta-notice.zh.md)保留注册的原因相同，并取代后续[共用弹窗恢复](../feature/2026-08-13-shared-modal-product-onboarding.zh.md)的简洁测试阶段声明。[版本化 GUI 欢迎引导](../feature/2026-07-30-versioned-gui-welcome-onboarding.zh.md)中的设置外壳协调器保持不变。

## 曾考虑的替代方案

**只改写声明文案并保留弹窗。** 不予采用：需求是彻底删除该声明，而不是改文案。

**连 `ui-onboarding` namespace 一起注销。** 不予采用：既有设置文档已经包含该分节，而设置 seam 会用已注册的 namespace 校验存储文档。

**保留无 UI 的进程内确认路径。** 不予采用：那会留下没有任何步骤消费的字段读写死代码。

## 后果

全新 profile 仅在没有任何可用提供方时才会看到 DeepSeek 密钥弹窗；否则直接进入应用。已经写在 `welcomeNoticeVersion` 下的值会被忽略。远程与回环浏览器在这条插页上不再有差异，因为没有任何界面再展示它。
