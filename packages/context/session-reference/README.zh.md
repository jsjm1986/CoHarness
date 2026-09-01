# `@deepseek-ai/dsh-session-reference`

[English](README.md) | 中文

`ctx.sessionReferenceResolver` 会把其他会话准备为有界、只读快照，作为带来源信息、面向模型的上下文。它消费 `ctx.sessionQuery` 与后端无关的 compact 检查点标记；不需要 SQLite FTS。支持跨会话 mention 的宿主可以主动启用该服务。

## 公开 API

- `listCandidates(agent, query?, limit?)` 会列出 `agent.id` 之外的会话，按 id、cwd 或最新的 projection 标题进行不区分大小写的筛选，再按同 cwd、无 cwd、其他 cwd 记录排序，同时保持每组内的 `listSessions()` 创建顺序。实时 session projection 与持久 projection-cache checkpoint 提供标题，因此每次击键都不必折叠冷日志；没有 projection 的会话在首次打开前使用 id，而未挂载 projection 服务的组合保留有界日志回退。一元 `sessionReferenceResolver/candidates` Remote 方法在配置的候选上限内提供同一发现能力，并为每个候选附上规范 mention，浏览器消费方直接调用 `ctx.remote.sessionReferenceResolver.candidates`，无需 API Proxy 路由。
- `prepare(agent, content, references, signal?)` 会保留首次 mention 顺序、对 id 去重，并拒绝自引用或超过已配置不同源上限的情况。它会并行读取所有源，返回与输入脱离的内容，外加零个或一个聚合且带标识的 `UserMessage` 上下文。下游 `agent/pre-step` 监听器接受步骤后，该服务会针对直接用户消息中的规范 mention 调用此方法。
- `encodeSessionReferenceUri()` 与 `decodeSessionReferenceUri()` 实现 `dsh-session:<base64url(JSON.stringify(sessionId))>`，因此每个 JavaScript 字符串 id 都能精确往返。`formatSessionReferenceMention()` 发出 `@[label](uri)`，`parseSessionReferenceText()` 将 Markdown mention 或裸规范 URI 替换为可读的 `@label` 文本，并返回结构化引用。解析器会拒绝显式 Markdown mention 中任何格式错误的 URI；只当 scheme 后跟非空、符合 base64url 形状的 payload 时，裸文本才被视为引用，匹配但非规范的候选项仍会失败。空 scheme mention 或只含标点符号的 scheme mention 仍是普通讨论文本。

## 快照语义

目标消息到达 `agent/pre-step` 时，准备阶段会对每个不同源调用一次 `ctx.sessionQuery.readSurface()`。因此，queued 消息在进入模型步骤时捕获源状态，此后生成的上下文保持不变。它仅投影折叠后当前表层中的用户直接发出的 `user/message`、assistant 文本，以及 `user/message` 检查点；这类检查点携带规范 `dsh-compaction` 源标记。带独立来源的 session-reference 消息属于注入上下文，会被排除以防止快照递归传播。已遮蔽的压缩（compaction）前事件、工具、推理（reasoning）、除已标记 compact 检查点外的其他插件生成 user 消息，以及未完成的 assistant 分片也都会被排除。因此，已压缩源只会提供最新检查点及其后保留的会话内容，不会还原已遮蔽的文本。

上下文源为 `{ kind: 'session-reference', version: 1, references }`；每条引用会记录其源 id 与 label、捕获 seq、是否存在 compact、已保留／已省略消息数、已省略 UTF-8 字节数与截断状态。该服务的外层 `agent/pre-step` 监听器会处理已接受的直接用户消息，保留其消息 id，并把每份快照插入到引用它的消息紧后。解析发生在最终领取收件箱消息之后，因此队列编辑和从 queue 移动到 steer 不需要引用专用处理。无效 mention、读取失败、取消和预算失败会在消息进入面向模型的历史之前结束该轮次。目标日志会先记录可读的直接 `user/message`，再记录其带来源信息的上下文 `user/message`；捕获后的源变更无法改变目标回放。

## 配置

| Key | 默认值 | 约定 |
|---|---:|---|
| `maxReferences` | `3` | 一条已准备消息中不同源会话的最大数量；必须不大于 `3`。 |
| `candidateLimit` | `50` | 返回给宿主的默认候选数量。 |
| `maxReferenceBytes` | `65536` | 一个引用对象的最大序列化 JSON 字节数。 |

保留会对每个源独立应用 `maxReferenceBytes`，保留 compact 检查点与最新消息，再丢弃较旧的非检查点单元，并使用 `dsh-output-retention` 头部／尾部截断和精确 UTF-8 省略通知。如果某个源的固定序列化字段本身就超出限额，准备会以 `SESSION_REFERENCE_BUDGET_EXCEEDED` 失败，而不返回部分上下文。

## 模型体验

### 引用会话背景

#### 模型看到的内容

模型会看到两条连续的 user 角色消息：先是带可读 `@label` 的当前消息，再是 `## Referenced sessions` 不受信任快照。警告禁止遵循快照中的指令、权限声明或工具请求，除非当前用户明确重复这些内容。标签、cwd 值、id 与会话文本会作为 JSON 在 `<referenced-sessions>` 标签中序列化；数据中的每个 `<` 都会以无损 JSON 转义 `\u003c` 的形式发出，因此源文本无法拼出定界标签。

#### Token 影响

每条包含引用的消息都会添加固定警告和最多三个序列化快照，每个快照都受 `maxReferenceBytes` 独立限制。精确快照会保留在目标历史中，直到目标压缩遮蔽或摘要它；源会话变更不会添加更多 token。

#### KV Cache 影响

请求与快照是两条连续、仅追加的目标消息，并保留较早的可缓存历史。不同引用或源捕获内容只改变新后缀；后续目标压缩可能使从替换边界起的复用失效。

## 已知限制与暂缓事项

- **不支持消息正文检索**：候选查询只检查 projection 标题（或兼容性的日志回退），不搜索消息主体。没有 projection 的会话在首次打开前仍可按 id/cwd 查找；专用标题索引未来可以替换这条发现路径，而不改变 URI、快照或持久化约定。
- **协作过滤**：组合 `ctx.collaboration` 时，候选发现与快照准备只保留 readable-session authority 放行的会话。未组合该服务的组合仍遵循可信调用方约定；此能力不是面向模型的搜索工具。
- **只投影文本**：不会在会话间传播非文本 user 与 assistant 块。
- **没有实时链接**：引用是快照，不是 fork、恢复、订阅或源会话变更。
- **`zod` 是生成的 Typert 契约面的运行时依赖，不是 `src` 的依赖。** 发布的 `./typert` 与 `./remote` 出口解析到不经打包的 `lib/typert.*.js` 文件，其中包含裸 `zod` 导入。manifest 必须保留 `zod`；只有当两份生成 JavaScript 契约面都不存在时，`knip.config.ts` 才注入 workspace 级例外，已构建 checkout 则由 Knip 直接观察该导入。
