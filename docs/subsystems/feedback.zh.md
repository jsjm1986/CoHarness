# 消息反馈

[English](feedback.md) | 中文

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback)拥有针对单条 assistant 消息的可编辑反馈。权威 Session 日志保存 `feedback/message-put` 和 `feedback/message-delete`；不可变的 Session 级备注仍使用 `feedback/record`，由 [`@deepseek-ai/dsh-command-feedback`](../../packages/feedback/command-feedback) 连同两种反馈共用的 `FeedbackCategory` 分类表一起拥有。三者都是仅写日志的事件，绝不进入模型上下文。

来源：[`packages/feedback/message-feedback/src/types.ts`](../../packages/feedback/message-feedback/src/types.ts)

## 公开类型

条目词汇——`MessageFeedbackVersion`、`MessageFeedbackRating`、`MessageFeedbackItem`、`FeedbackCategory` 与 `FeedbackRecord`——是在 `@deepseek-ai/dsh-session/types` 中声明的持久 Session 日志词汇，文档见 [Session 子系统页面](session.zh.md)；本包重新导出它们，使 Remote 客户端只需依赖一个包。本包自行声明下列请求、结果与事件 payload 类型。

```ts type-equiv
/** A material creation or edit, retaining its complete current value. */
interface MessageFeedbackPut {
  /** Owning Session; inherited feedback in a fork belongs to its parent. */
  readonly sessionId: SessionId
  /** Value after this mutation, including the original creation time. */
  readonly item: MessageFeedbackItem
}
```

```ts type-equiv
/** A material deletion of one current feedback item. */
interface MessageFeedbackDelete {
  /** Session that owns the deleted feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback was removed. */
  readonly messageId: MessageId
  /** Version of the removed item. */
  readonly version: string
}
```

```ts type-equiv
/** Read all message feedback belonging to one persisted Session lifecycle. */
interface MessageFeedbackListRequest {
  /** Session whose feedback events should be read. */
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Current feedback values for one Session, in first-creation order. */
interface MessageFeedbackListValue {
  /** Fresh immutable item snapshots. */
  readonly items: readonly MessageFeedbackItem[]
}
```

```ts type-equiv
/** Create or replace feedback for one assistant message. */
interface MessageFeedbackPutRequest {
  /** Persisted Session that owns the target message. */
  readonly sessionId: SessionId
  /** Target assistant-message identity. */
  readonly messageId: MessageId
  /** Desired overall judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional non-blank explanation. */
  readonly note?: string
  /** Optional category; absent keeps the item uncategorized. */
  readonly category?: FeedbackCategory
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}
```

```ts type-equiv
/** Delete feedback for one message after observing its current version. */
interface MessageFeedbackDeleteRequest {
  /** Session that owns the feedback. */
  readonly sessionId: SessionId
  /** Message whose feedback should be absent after this operation. */
  readonly messageId: MessageId
  /** Observed item version; ignored when the item is already absent. */
  readonly ifVersion: MessageFeedbackVersion
}
```

```ts type-equiv
/** Idempotent deletion acknowledgement. */
interface MessageFeedbackDeleteValue {
  /** Stable postcondition shared by the first deletion and every retry. */
  readonly absent: true
}
```

```ts type-equiv
/** No persisted Session header exists for the requested id. */
interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** The id does not name a derived, append-origin assistant message. */
interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}
```

```ts type-equiv
/** A material mutation did not match the addressed item's current version. */
interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** Authoritative current item, or `null` when it does not exist. */
  readonly current: MessageFeedbackItem | null
}
```

```ts type-equiv
/** A supplied note contains no non-whitespace character. */
interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}
```

```ts type-equiv
/** A supplied note exceeds the configured UTF-8 byte limit. */
interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}
```

```ts type-equiv
/** Failures shared by the public message-feedback operations. */
type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge
```

```ts type-equiv
/** Successful public operation result. */
interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}
```

```ts type-equiv
/** Rejected public operation result with a stable business failure. */
interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}
```

```ts type-equiv
/** Result returned by the message-feedback `list` operation. */
type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>
```

```ts type-equiv
/** Result returned by the message-feedback `put` operation. */
type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >
```

```ts type-equiv
/** Result returned by the message-feedback `delete` operation. */
type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>
```

## Session 反馈类型

来源：[`packages/feedback/command-feedback/src/types.ts`](../../packages/feedback/command-feedback/src/types.ts)

`feedback/record`、`FeedbackCategory` 与 `FeedbackRecord` 是在 `@deepseek-ai/dsh-session/types` 中声明的持久 Session 日志词汇，文档见 [Session 子系统页面](session.zh.md)；本包重新导出它们，并自行声明下列 `sessionFeedback.record` Remote 类型。

```ts type-equiv
/** Record one Session-level remark through the Host Remote. */
interface SessionFeedbackRecordRequest {
  /** Live Session the remark describes. */
  readonly sessionId: SessionId
  /** Free-text remark; blank text is recorded as absent. */
  readonly text?: string
  /** Category the human filed the remark under. */
  readonly category?: FeedbackCategory
}
```

```ts type-equiv
/** Stable postcondition of a recorded remark. */
interface SessionFeedbackRecordValue {
  /** The remark is appended to the Session log; flushing follows the Session's own schedule. */
  readonly recorded: true
}
```

```ts type-equiv
/** No live Session carries the requested id. */
interface SessionFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Result returned by the `sessionFeedback.record` operation. */
type SessionFeedbackRecordResult =
  | { readonly ok: true; readonly value: SessionFeedbackRecordValue }
  | { readonly ok: false; readonly error: SessionFeedbackSessionNotFound }
```

## 数据与并发

当前条目由 payload 中 `sessionId` 与所属 Session 匹配的权威反馈事件归约得到。每个条目携带好评或差评、可选备注、可选分类、Host 分配的 `createdAt`/`updatedAt` 时间戳及自己的 opaque version。version 只能用于相等比较，且只与目标消息比较；调用方不能排序或自行合成它。

`put` 采用严格乐观并发：已有条目的每次请求都必须匹配当前 `ifVersion`，即使请求不会改变目标值（重复已存评分、备注与分类的 put）。冲突会返回权威当前条目（不存在时为 `null`），因此调用方无需额外读取，即可协调丢失响应或并发编辑。删除已经不存在的条目同样成功。按 Session 划分的队列串行执行读取与变更；cold 变更在读取、比较、追加和 flush 期间持有持久化写句柄。匹配版本的无变更操作不追加事件。

## 目标与生命周期权威

live 持有者的内存日志直接提供目标 Session 的观测；cold 读取使用 `SessionPersistence.open(id, 'read')` 句柄，变更则使用写句柄。两条路径都不构造 Session 或 Agent。先由 `stat(id)` 预检明确不存在；`stat` 已确认存在的 Session 若读取失败，会按基础设施故障原样传播。`put` 只接受具有指定 `MessageId` 的非空、append-origin `assistant/message`；replacement-origin、仅承载 usage 的空记录和非 assistant 记录都不是反馈目标。

fork 种子可以包含父 Session 的反馈事件，但 payload 保留父级 `sessionId`，因此不会成为子 Session 的当前反馈。删除条目会追加删除标记；早先的评分与备注仍保留在日志中。

## 持久化与 Remote 约定

成功的消息反馈变更会等待权威持久化完成：live 操作通过所属 Session 追加，并要求有 `ctx.sessions.flush` 监听器参与；cold 操作通过写句柄追加并 flush。持久化故障会原样传播，不会报告成功。`maxNoteBytes` 为必填项，按 UTF-8 字节限制备注文本；具体取值由组合的 Host 决定。该包通过 `TypertRemoteService` 与 `@Remote` 发布 Host `messageFeedback.list`、`messageFeedback.put` 和 `messageFeedback.delete` 一元 Remote 约定；`command-feedback` 以同样方式发布面向 live Session 的 Session 级备注 `sessionFeedback.record`。下方生成的 Cordis API 是方法级权威。

插件释放会关闭操作接纳，并排空已进入各 Session 队列的工作。

启用后，[`session-log-deepseek`](../../packages/session/session-log-deepseek/README.zh.md) 会在后续符合条件的 DeepSeek 请求中，把反馈作为普通 `dsh_session_log` 后缀的一部分传送；`enabled` 默认为 `false`。记录反馈不会触发 LLM 请求，也不会单独上传 `dsh_feedback`。对于非 DeepSeek 路由，[OTel 后端](../../packages/session/session-telemetry-otel/README.zh.md)可以将权威日志前缀释放至已记录的反馈。命令确认文本确认记录并标识 Session 与匿名用户，不报告遥测策略或投递结果。

## Remote 消费方

目前没有任何已发布的组合挂载这两个服务，也没有已发布的客户端消费它们。预期的接缝是：Host 组合加载这两个插件，使 `ctx.messageFeedback`/`ctx.sessionFeedback` 服务存在；由 [`dsh-api-remotes`](../../packages/api/remotes) 的贡献挂载生成的 `messageFeedback` 与 `sessionFeedback` Typert remote，使调用方通过 `ctx.remote.messageFeedback`/`ctx.remote.sessionFeedback` 发起调用；以及一个从产品界面驱动已发布 Remote 方法的客户端包。`/feedback` 命令在任何于 `commands` 旁加载 `command-feedback` 的 Host 组合中都可用，因为该插件直接在共享注册表上注册它。

## 边界与限制

- 操作队列仅在进程内生效；cold 写入排他性依赖所选持久化提供方。
- 删除只移除当前条目，不会抹除 append-only 日志或已投递后缀中的早先备注。
- 请求若恰好落在 live detach 之后、persistence catalog 物化 header 之前的极短窗口，可能收到 `session-not-found`；调用方应在 retirement materialization 后重试。
- cold 请求读取完整日志；服务没有条目数或聚合字节上限。`maxNoteBytes` 只限制每条备注。
- Host 约定不记录已认证的 actor 或审计身份，因此假设调用方边界可信。
- `sessionFeedback.record` 只服务 live Session，否则回答 `session-not-found`。
- Session 级备注没有大小上限；`maxNoteBytes` 只覆盖消息备注。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Session-log service; cold operations never construct a Session or Agent.

```ts cordis-catalog
/**
 * Read current feedback from the canonical log.
 * @param request - Session to inspect.
 * @returns immutable items or a definite persistence miss.
 */
@Remote('list') list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback after checking its current version.
 * Matching no-ops retain the version and append no event.
 * @param request - Target, desired value, and observed item version.
 * @returns the durable item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one item after checking its version; absence succeeds without an event.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)

<a id="ctxsessionfeedback--sessionfeedbackservice"></a>

### `ctx.sessionFeedback` — `SessionFeedbackService`

Host Remote through which a product surface records a Session-level remark.

```ts cordis-catalog
/**
 * Record one remark on a live Session.
 * @param request - target Session plus the optional text and category.
 * @returns the recorded postcondition, or `session-not-found` when no live
 * Session carries the id.
 */
@Remote('record') record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult>
```

Source: [`packages/feedback/command-feedback/src/index.ts`](../../packages/feedback/command-feedback/src/index.ts)

<a id="feedback-events"></a>

### `feedback/*` events

<a id="feedbackcommitted--parallel"></a>

#### `feedback/committed` — parallel

Observe a durable cold feedback mutation without publishing a live Session. Observers run before write ownership is released and must not await another message-feedback operation for this Session. The payload is borrowed read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).

```ts cordis-catalog
/**
 * Observe a durable cold feedback mutation without publishing a live Session.
 * Observers run before write ownership is released and must not await
 * another message-feedback operation for this Session. The payload is borrowed
 * read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).
 * @param inspection - committed canonical prefix, including the feedback as its last event.
 * @mode parallel
 */
'feedback/committed'(inspection: SessionInspection): void
```

Types: [SessionInspection](persistence.zh.md)

Source: [`packages/feedback/message-feedback/src/index.ts`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
