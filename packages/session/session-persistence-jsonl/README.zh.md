# @deepseek-ai/dsh-session-persistence-jsonl

[English](README.md) | 中文

JSONL 持久会话存储后端：`SessionPersistence` 的一个具体实现（`dsh-session-persistence` seam）。每个会话有一个仅追加的逻辑 JSONL 日志，默认存储为 `.jsonl.zstd`；禁用压缩时使用原始 `.jsonl`。

## 概述

`dsh-session-persistence-jsonl` 把每个会话存为当前的仅追加 JSONL 日志，并保留不可变的历史格式 generation——默认以带校验和的 Zstandard 帧存储，禁用压缩时以换行分隔的原始文本行存储。它通过持久化句柄提供当前逻辑 `SessionEvent` 流，因此格式迁移、压缩、历史解码与崩溃恢复仍是存储内部细节。当消费方需要按会话的磁盘文件时选择它；选择 `compression: 'none'` 后日志可作为纯文本按行读取。根目录是唯一必填配置；持久性、延迟实体化、[受支持的历史格式迁移](../session-format-catalog/README.zh.md)与撕裂尾部崩溃恢复都随后端提供。

## 磁盘布局

```
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.v4.jsonl.zstd      # default: checksummed header frame + append frames
      session.v4.jsonl           # only with compression: 'none'
```

- 当前 artifact 为 `session.v4.jsonl.zstd` 或 `session.v4.jsonl`；已提交的旧 generation 保留各自的版本名称。第一个逻辑行是标记为 `{ type: 'session', version: 4, id, cwd?, createdAt, parentSession?, isSeeded, origin?, delegationDepth, agentPreset?, draft? }` 的 header。`isSeeded` 必须显式提供；继承前缀长度由带继承标记的 `session/end-seed` 记录携带。`delegationDepth` 在磁盘上必需，顶层 Session 为 `0`。可选 `draft` 字段只接受布尔值，两个显式取值都会在列表、检查和冷读取时保留；省略仍保持缺失。未知 header 字段仍然无效。`agentPreset` 必须持久化，因为它决定恢复后的工具与提示词。当前格式的后续每行存储一条已收敛的 Session 事件，包括其中嵌套的 Assistant 流数据，事件序号保持连续。
- 存储记录是逐条原样的 `SessionEvent` JSON。发布版 v0/v1 artifact 可能包含**分片打包行**（`text-chunks`／`reasoning-chunks`／`tool-call-chunks`；使用无斜线标签避免与事件类型混淆）：一行保存至少 3 个连续同块 `assistant/chunk` delta 事件，`seq0`／`time0` 与各成员的 `dt` 间隔可精确重建每个成员。无损 codec 位于 `@deepseek-ai/dsh-session`（`packChunkRuns`／`decodeStorageRecord`）；当前写入端从不打包——打包行只会经由 catalog 解码的历史 generation 进入此后端，加载结果与非打包行一致。
- surface 的 `sourceEventSeqs` 数组在连续段有收益时使用无损闭区间范围；读取方同时接受范围形式和旧的数字数组形式。
- 项目目录保留规范化 cwd 的可读形式，便于导航，并限制在文件系统组件上限内。分隔符替换和截断刻意有损，因此规范化相同的 cwd 字符串共享项目目录；会话 id 仍选择不同会话目录。在不区分大小写的文件系统上，只有文件系统规范化将两种写法解析到同一 transcript（文本记录）时，身份验证才接受备选路径写法。配置根仍由部署控制：可以是项目本地、共享、临时或集中式。[项目会话目录决策](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.zh.md) 记录这项取舍。
- 会话 id 是未验证的带品牌类型的字符串，因此在使用前单射转义为一个安全路径段（无遍历、无冲突）。结果目录保留给其他会话自有产物；发现只读取固定 transcript 文件名。

## 配置

| 键 | 类型 | 说明 |
|---|---|---|
| `root` | `string`（必需） | 所有会话文件的根目录。**无默认值**：`process.cwd()` 默认值会随进程 cwd 变更（bash 调用、子进程）而分散文件。现有根必须是可读目录；缺失根在第一次实体化时创建。 |
| `compression` | `'zstd' \| 'none'` | 默认 `'zstd'`；`'none'` 保留换行分隔 UTF-8 文本。 |

`locate(meta)` 返回已解析项目/会话目录内固定 transcript 的 `{ kind: 'jsonl', path }`。它不执行文件系统 I/O：可以在目录或文件存在前返回目标，现有文件也只包含最近一次 flush 完成的前缀。

## 物理编码

默认产物是独立 [Zstandard frame](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md) 的标准拼接：一个仅包含 header 行的带 checksum frame，后跟每个持久 append 批次一个带 checksum frame。后端使用 Node 内置 Zstandard API 和默认压缩级别，不提供级别开关。列表只读取并验证 header frame。`compression: 'none'` 在原始表示中保留相同逻辑行。

一个根只属于一种编码。启动发现和定向查找会拒绝相反 suffix，错误会命名不兼容产物，并指示调用方选择匹配 mode 或独立根。平铺 `<project>/<id>.jsonl*` 产物也会被拒绝，而不是忽略。格式迁移会保留已配置编码；不支持压缩转换、混合根回退或双写。

## 持久性与崩溃语义

- **绑定存储身份。** 查找要求可读项目目录中只有一个匹配会话目录，然后验证 header id 等于请求 id，且 header id/cwd 派生所选 transcript 路径。列表应用同一路径检查，并拒绝重复 id。身份失败发生在修复或 append 前。
- **延迟实体化。**`create(meta)` 不写入；浏览器草稿会把边界和策略事件保留在内存中，直到出现实体化事件，后端才把完整缓冲前缀和第一批写入临时文件并执行 `fsync`。出现可见消息后 header 会退出草稿状态；仅命令工件仍对普通列表隐藏。POSIX 通过硬链接无覆盖发布，并对父目录 `fsync`。Windows 通过 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` 无覆盖发布，并通过同一 write-through pattern 创建缺失目录。已创建但从未 append 的会话不留下磁盘内容，不在 `list` 中。
- **仅追加。** 已 flush 事件绝不重写。后续原始批次 append 行；压缩批次 append 一个 frame。两条路径都执行 `fsync`，并在捕获到写入或同步失败时回滚到之前字节长度。
- **崩溃恢复：保留有效尾部工作。**`load` 验证每个完整压缩 frame，并扫描解压 JSONL。最后 frame 结构不完整时，读取器保留其完整解码记录，从 frame 开头截断，并使用共享[持久化约定](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.zh.md) 需要的合成工具、步骤和轮次 closer 重新编码这些记录。原始 mode 从第一个不完整行截断。已经存在却没有完整 header frame 的压缩工件、完整 frame 中的 checksum/解压失败，或位于最后已提交的 `turn/end` 处或之前的缺陷都属于损坏，会被拒绝。
- **非修改式检查。**`inspect()` 返回带精确继承切点的不可变、平衡逻辑视图，并可在内存中合成恢复 closer，但不会截断不完整尾部或更改轻量修订。`readFrom(id, fromOffset)` 接受 `SessionLogOffset`，解析整个工件后向前跳过，把后缀与同一切点一起返回；仅读 header 的列表暴露 `isSeeded`，无需读取事件体。
- **连续 seq。**`append` 拒绝第一个 `seq` 不继续已存储日志的批次，并拒绝无法 JSON 序列化的 `event.data`，同时命名违规事件类型。
- **轻量修订。**`revision(id, signal?)` 只解析指定产物，并使用 device、inode、size 和纳秒时间戳标识它，不解析日志；`listSnapshots(signal?)` 对每个已发现产物使用同一身份。该标识会在 append、修复、替换或存储变更后改变。完整前缀读取要求读取字节前后的身份一致，`readStoredRevision()` 也使用同一身份校验保留的 preparation。快照列表通过产物发现原样转发该信号，并在每个 `stat` 前后检查取消；由于文件系统 `stat` 不可中断，取消会等待活动调用完成，然后在不启动另一次调用的情况下拒绝。

## 写入路径

插件将冻结的会话事件复制到每个活动会话各自的写句柄。活动事件的批处理窗口是 seam 内部调度策略而非配置项：句柄内的批处理窗口把活动缓冲区合并为一次持久化追加，`session/flush` 或 dispose 会排空当前与待处理批次。每会话游标防止恢复后的会话重新 append 已存储事件，插件加载时会为活动会话设置初始状态。所属后端实例串行化单会话操作；dispose（资源释放）会在拆卸前排空每个保留的写句柄。每个逻辑事件都会保留：批处理只让单个压缩帧或一次原始 JSONL fsync 承载更多记录。

明文正文按有界字节窗口扫描，保留解码后的事件，不构建完整原始文件缓冲区。读取之间检查取消，revision 变化时重试。后继 generation 写完临时文件后重新校验源 revision；源发生变化或消失时拒绝发布。后继 generation 按有界批次编码，在事件和写入之间检查取消。压缩读取和逻辑 preparation 仍保留完整输入或事件数组。

## 不变量

**运行时不变量：** 未发布配套入口。每个会话是一个只追加日志，其生命周期由共享协调器规格覆盖；后端只增加字节级存储。

## 模型体验

### 恢复的对话历史

#### 模型看到什么

JSONL 存储不会向实时请求提供提示词或 schema。加载会恢复已存储的表层历史，并保留之前的请求 header 用于重建；新 loop 组合当前 envelope。恢复会用 `TOOL_NOT_STARTED` 平衡没有持久调用的 assistant 请求；持久调用无结果时则变为 `TOOL_OUTCOME_UNKNOWN`，它要求模型只重试只读或幂等工作，并验证可能的副作用或询问用户。嵌入式 Assistant stream 与仅日志 attempt 不会重复生成消息。

#### Token 影响

实时请求不新增 token。恢复后的 agent（智能体）会因保留的历史、当前 envelope，以及每个中断调用中以引用形式加入的修复结果文本而消耗 token。

#### KV Cache 影响

JSONL 存储不修改实时请求前缀。只有重建历史、当前 envelope 与模型路由匹配时，恢复 loop 才能重用提供方缓存；崩溃修复结果仅追加。

## 已知限制与暂缓事项

- **只加载已配置编码和 catalog 中的 generation**：此 backend 会把发布版 v0/v1/v2/v3 artifact 迁移到当前 v4，并保留源文件；更改压缩需要独立 root，保留的旧 generation 不提供自动回退或降级。
- **平铺文件存储布局不加载**：加载前使用独立根，或将预发布产物移入项目/会话目录布局。
- **压缩文件不能直接按行读取**：使用后端加载；或在写入新根前选择 `compression: 'none'`，以便外部行 reader 使用。
- **不删除会话文件**：日志在 `root` 下累积，直到外部移除（seam 无删除接口）。
- **每会话一个活动 writer**：写句柄在整个生命期持有 `<root>/.locks/<id>.lock` 上的内核租约（POSIX 非阻塞 `flock`；Windows 命名内核信号量），因此第二个后端实例或进程写打开同一会话时以 `SessionAlreadyOwnedError` 失败，直到所有者释放或其进程退出。活着但卡死的持有者会一直阻塞到进程退出——删除锁文件是 POSIX 上的显式放弃手段——且咨询式 `flock` 在 NFSv3 上不可靠，此类根目录上的排他会退化为仅进程内。初始同 id 发布仍通过 POSIX 无覆盖硬链接或 Windows 无替换 write-through rename 保持冲突安全。
- **POSIX 实体化需要硬链接支持**：第一次 append 使用 `link()`，使同 id 竞态失败，而不覆盖已提交日志；Windows 使用无替换 write-through rename。
