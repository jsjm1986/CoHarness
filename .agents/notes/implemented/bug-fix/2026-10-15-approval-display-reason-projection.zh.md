# Agent Note：审批面板经 wire 投影本地化的 displayReason

状态：已实现

[English](2026-10-15-approval-display-reason-projection.md) | 中文

## 问题

ask 决策契约早已携带可选的本地化 `displayReason`(`PreToolDecision`、`ApprovalRequestEvent`、auto-review 与沙箱升级询问方），但提示链在 wire 上丢了它:apiproxy 的未决登记表只把 `reason` 放进 `approval/requested` mux 帧，编辑器的审批面板因此在中文 locale 下仍渲染审计用英文理由。上游来源是 ask 兜底修复 `0a134ef94ef`（其前置的 `approval` 本地化特性 `12c9dd599e7` 更早；两者均在 alpha.2 内）。

## 决策

`displayReason` 现在贯穿整条请求路径:`approval/requested` 帧类型与其 zod schema(`{ en: string }` 加开放 locale 键）、proxy 未决登记表都把它与 `reason` 并列转发；客户端 `PendingApproval` 领域面将其暴露；`conversation.composer` 注册注入绑定到 `ctx.locale.resolveText` 的 `resolveReason`;`ApprovalPanel` 在有映射时渲染解析结果，否则回退 `reason`、再回退提权文案。审计对 `approval/asked`/`approval/decided` 仍只记录 `reason`——`displayReason` 仅作呈现、绝不持久，与上游契约一致。

## 备选方案

**在询问方把本地化文本写进 `reason`。** 这正是上游修复的动机：耐久 `approval/asked` 事件必须保留可审计英文文本，因此呈现本地化只能并列携带，不能混入。

**不注入席位、在面板内解析映射。** 组件没有服务访问权；入口的 `inject` 是合规绑定点，且使映射类型与 wire 保持同形。

## 影响

来自 `kind: 'ask'` 决策的审批提示随活跃 locale 的回退链本地化（映射中 `en` 必填)。需要审计文本的消费方继续读未变的 `PendingApproval.reason`。schema 校验接纳 `en`/`zh` 之外的 locale 键而不逐一列举。

## 验证

`api-proxy-approval.spec.ts` 断言请求帧在 ask→广播→回放全程同时携带审计理由与映射。`approval-panel.client.spec.tsx` 验证有映射时渲染解析后的中文文案、无映射时渲染原文理由、两者皆无时渲染提权兜底。rpc-schemas 语料在放宽后的帧下仍全部通过。

## 关联

- [2026-08-28 Auto review](../feature/2026-08-28-auto-review.zh.md)——其拒绝产生本地化 display reason 的询问方。
- [2026-07-23 Web 权限与审批](../feature/2026-07-23-web-permission-and-approval.zh.md)——本面板占据的编辑器接管面。
