# Agent Note: 会话表面线协议词汇表单一事实源

Status: implemented

[English](2026-09-15-shared-session-surface-wire-vocabulary.md) | 中文

## Problem

三个原始事件入口边界各自维护了一份表面事件词汇表的私有副本：运行时会话的包络校验、Gateway 的 `conversationEvents` 追加入口，以及 session-persistence Gateway 适配器的响应校验。镜像字面量会静默分叉：Gateway 的副本早于 `system/message` 的表面资格，且只接受旧式 `start`/`end` 替换键，于是携带 `surfaceOp` 的 `system/message`、或规范 `startSeq`/`endSeq` 替换的生产追加被以笼统的持久化错误拒绝，会话可读但无法继续。

## Decision

`@deepseek-ai/dsh-session-format/surface` 以纯模块形式拥有该线协议词汇表，与它描述的格式版本同层：`SESSION_SURFACE_EVENT_TYPES` 列出四种表面事件类型，`isSessionSurfaceEventType` 判定成员资格，`isSessionSurfaceOp` 接受 `'append'`、规范的 `{ op: 'replace', startSeq, endSeq }`，以及已提交代次仍携带的旧式 `{ op: 'replace', start, end }`。每个入口边界消费共享模块：`core/session` 的表面资格判定、Gateway 的包络校验器、持久化适配器的响应检查。类型不在本构建已知词汇表内且携带 `ignorable: true` 的事件，在每个边界都保留不透明的 `surfaceOp`/`sourceEventSeqs`，与[规范会话事件入口](2026-09-14-canonical-session-event-ingress.zh.md)的采纳规则一致；普通日志事件上的当前格式表面元数据仍然拒绝。

## Alternatives considered

**保留各边界私有副本。** 否决：副本已在生产分叉，且每次分叉都以远离根因的笼统错误拒绝合法事件。

**由 `core/session` 持有词汇表。** 否决：Gateway 与持久化适配器在无 Session 的情况下校验原始线事件，词汇表描述的是线格式，应属于三个边界都已依赖的格式包。

**只共享类型。** 否决：分叉发生在运行时字面量上——`Set` 成员判定与替换键对检查——类型声明无法约束。

## Consequences

新增表面事件类型或替换键对只改一个模块，各边界按构造接受相同事件。该模块是无共享运行时身份的纯线格式代码，因此客户端打包纯度门禁经 `INLINE_SAFE` 放行该子路径，裸包仍保持外部化。校验强度不变：格式错误的当前代次事件、多余包络键、已知非表面事件上的表面元数据仍在每个边界拒绝，旧代次事件体在放宽的一致性规则下保持可读。

## Verification

`gateway/tests/runtime-api.spec.ts` 覆盖携带 `surfaceOp` 的 `system/message`、规范替换的接受、ignorable 豁免与每条拒绝规则。`packages/session/session-format/tests/surface.spec.ts` 钉住词汇表，`packages/session/session-persistence-gateway/tests/gateway.spec.ts` 覆盖旧代次放宽与当前格式的严格拒绝。
