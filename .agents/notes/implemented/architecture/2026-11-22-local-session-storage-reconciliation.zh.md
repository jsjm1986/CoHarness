# Agent Note: 复用已校验的本地 Session 观察结果

Status: implemented

[English](2026-11-22-local-session-storage-reconciliation.md) | 中文

## 问题

对活跃 Session 的相同日志重复搜索会复制整份日志并计算摘要。刷新持久索引也会串行读取本可独立完成的数据。SQLite 追加校验通过 JavaScript 生成 schema 对象，常规投影写入为已脱离实时状态的检查点再分配一份副本。检查点定时器可能在首次触发事件对应的 Agent 操作结束后，仍保留该 Agent 身份。

## 决策

[SQLite 持久化提供方](../../../../packages/session/session-persistence-sqlite/README.zh.md#schema-compatibility)在每次写事务中，将数据库的实际有序 schema 与标准表示比较。仅空白有差异的等价定义仍可使用。

[SQLite 搜索提供方](../../../../packages/session-query/session-query-sqlite/README.zh.md#source-and-index-lifecycle)仅在同一个只追加的 Session 实例的事件数未变时复用精确指纹。头信息和已接受的事件保持不可变。持久数据按源修订号识别。并发检查受限，已开始的检查全部结束后才释放搜索队列。发布索引需要稳定的源观察结果。

[投影缓存](../../../../packages/session/session-projection-cache/README.zh.md#write-policy)校验已经脱离实时状态的检查点，并等待相应 Session 的日志持久化后再发布。冷读检查点可能与调用方共享数据时会单独保留快照。定时器保留显式关联的 Session，并在存在 Agent 注册表时通过它清除发起 Agent 身份。

## 考虑过的替代方案

**只信任 SQLite schema cookie。** 仅检查 schema 版本号和 cookie 会让写入依赖元数据对目录的声明。在写事务中读取目录可以直接检查此次写入依赖的 DDL。

**缓存实时搜索文档或直接用事件数作为游标代次。** 保留搜索文档会产生日志副本，而且替换后的 Session 可能有相同的 ID 和长度。首次观察到新 Session 对象时，仍使用内容摘要判断内容是否确切相同。

**第一次检查失败时立即释放搜索。** 后端读取有可能忽略取消。等待已经开始的操作结束，可以确保销毁、替换数据源和下一次搜索都在这次 I/O 之后。

**直接复用冷读投影行。** 返回的快照可能与投影行共享数据，调用方能在写入排队期间修改这些数据。

## 结果

重复搜索不再复制未变的活跃日志或重算摘要。追加事件或替换 Session 仍会生成完整摘要。持久索引追赶时，可在配置的并发限制内同时使用多个读操作。

写入每次仍读取实际 schema，并沿用现有 SQLite 格式。实时投影写入少分配一份检查点副本。文件 I/O 和 Session 日志持久化仍会计入检查点耗时。
