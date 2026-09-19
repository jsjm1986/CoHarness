# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

持久投影缓存（`ctx.sessionProjectionCache`）：把每个投影单元的状态保存为检查点，基于域数据形态（domain data form）每会话一条记录（`session_projcache` 域——出厂 JSON 后端以 `per-record` 布局把每个会话存为一份带版本戳的文档：`<root>/session_projcache/sessions/<id>.json`）。设计权威：[session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.zh.md)（persisted projection cache 一节）。

一条存储行 `(key → {ver, seq, val})` 是折叠捷径，绝不是权威：可能陈旧（`seq` 精确说明陈旧到哪），但绝不会错。实现据此承诺：

- **每次后台写入都 fail-soft。** 持久写失败只记一条警告并保持缓存陈旧；下一次写入或冷读自愈。两次写之间崩溃的代价是更长的尾部回放，绝不是错误的值。
- **`ver` 与当前运行单元的 `stateVersion` 不匹配即丢弃，绝不迁移。** 单元递增版本会在读取时使其行失效；该 key 从日志重新折叠。
- **存储行必须通过当前单元的 `stateSchema`。** 畸形行从零 I/O view 中省略，并被 restore 拒绝，使冷读阶梯从日志重新折叠。
- **整记录写入。** 每次写入替换该会话的完整检查点（注册表切面始终是完整的），并经无损 JSON 边界快照——违反纯 JSON 约定的单元状态会显式失败并报错。
- **记录绑定到日志生命周期，而不只是 id。** 每条记录存储其折叠来源的完整生命周期身份（`formatVersion`、`createdAt`、`cwd`、`isSeeded` 与精确的 `inheritedEventCount`），因此来自另一 Session 格式世代或 fork 切点的行不能为调用方播种；每次读取先以活 header 或存储 header 为证验证它，再接受任何行——被删后重建的 id、或缓存幸存而持久化存储被换掉时，无关记录被整体丢弃，绝不播种幻影值。
- **日志领先，缓存跟随。** 活会话检查点先把缓冲事件持久 flush，缓存行才落地，因此崩溃只会让缓存落后于日志（更长的尾部回放），绝不领先于它。

## 写策略

三个必写点，其间节流：

| 触发 | 性质 |
|---|---|
| 会话创建 | 必写——在首个普通事件之前捕获由 seed 派生的投影状态。 |
| `turn/end` | 必写——冷读要的正是轮次终值。 |
| 会话释放（detach） | 必写——live 转 cold 的时刻；此后冷读阶梯接管该会话。 |
| 累计 `writeEveryEvents` 个已提交事件 | 配置节流（条数）。 |
| 距首个脏事件 `writeIntervalMs` 毫秒 | 配置节流（间隔）。 |

两个 `Config` 字段均必填（无默认值）：写入节奏是部署选择，没有普适正确值，由 cordis.yml 明示。

## 列表读（`cachedSnapshot(meta, inheritedEventCount, keys?)`）

零 I/O 一档：从身份匹配的存储记录直接 view 客户端值（仅版本与 state schema 均匹配的 key），以 `{asOfSeq, values}` 切面返回。`cachedPredecessorTitle(meta, inheritedEventCount)` 是更窄的列表专用例外：生命周期匹配且已通过结构准入的前任记录只能公开与当前版本兼容的 `title` 行——一个可能陈旧的事实，携带哨兵 `asOfSeq: -1`，绝不是折叠种子。无种子的列表项知道自己的切点是零；带种子但只有 header 的列表项不知道数字切点，必须跳过这两条快路，直到权威的事件体读取给出切点。`asOfSeq` 取所服务行的最低水位，客户端在 higher-seq-wins 规则下播种值存储时，陈旧列表块永远压不过更新的推送帧。host-only 行永不返回。无可用客户端行（未知 id、无关生命周期、无可用行）时返回 `undefined`；api-proxy 列表载体将其转为列缺席。

## 冷读（`coldSnapshot(meta, inheritedEventCount, events)`）

调用方提供该会话完整有序的日志（session-query 观察层是出厂生产者）；缓存在可用时以检查点行为每个单元播种，把供入事件折叠到切点，并刷新记录而不自行读取持久化。来自另一 Session 格式世代或生命周期的行永不匹配：每条记录绑定完整身份（`formatVersion`、`createdAt`、`cwd`、`isSeeded`、`inheritedEventCount`）。`hydratePrepared(session, events)` 是对已准备好的未发布 Session 做同样的播种再折叠，不写任何内容。

`write(session)` 是所有必写点共用的同步切面检查点；载体可以直接调用（非 fail-soft——由 fail-soft 包装层负责遏制）。

## 升级兼容性

该域以 `per-record` 布局把每个会话存为一份带版本戳的文档（`<root>/session_projcache/sessions/` 下），因此陈旧或畸形的记录单独丢弃，而不会使整个单元拒绝打开。`compatibleVersions: [3, 4, 5, 6]` 使结构有效的前任文档保持可读、供当前检查点重写，并允许旧的整体文件 `session_projcache.json` 在其存储版本被接受时做一次引导迁移；schema 校验失败的记录按 `invalidRecords: 'backup-and-skip'` 移到 `<id>.json.bak.<stamp>`，由下一次检查点重建。

## 组合

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

注入 `storageDomain`、`sessionProjections`、`sessions`。没有这一行时，投影系统只跑 live（水位缓存；冷读在实现了它的载体处退回全量日志折叠）。

## 模型体验

无，因为缓存只持久化并恢复 host 侧的、由已写入日志的会话状态派生的读模型，不触碰任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

**运行时不变式：** 不发布伴生入口。完整正确性关系只能通过对持久化日志重新执行折叠来检查；持久化边界通过 schema 校验，读路径的版本与水位防护由包规范证明，相关局部约束在写入与读取路径强制执行。

## 已知局限与延后工作

- **不提供淘汰或保留接口**：记录会按会话持续累积；清理已存储的检查点属于带外维护，与会话持久化采用相同策略。
- **间隔节流采用按会话的粗粒度控制**：一次无脏数据的写入完成后，计时器会在首个脏事件到达时启动；对于持续但未达到条数阈值的事件流，系统每个间隔写入一次，而不采用滑动窗口。
- **`coldSnapshot` 折叠不去重**——同一会话的两个并发冷折叠各自对供入日志播种再折叠；写回最后者胜（行等价），对列表级调用频率可接受。
