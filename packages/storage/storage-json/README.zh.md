# @deepseek-ai/dsh-storage-json

[English](README.md) | 中文

[存储中心](../storage/README.zh.md)的 JSON 后端：配置根目录下的人类可读 JSON，注册为后端 `json`。布局由领域规范选择：`single` 每单元保留一个完整的 `<unit>.json` 文件；`per-record` 在 `<unit>/<table>/<key>.json` 下每条记录保留一份带版本戳的文档，外加一个 `global.json`。设计见[领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 概述

`dsh-storage-json` 在配置的根目录下把领域数据存为可读 JSON，并注册为后端 `json`。默认的 `single` 布局为每个单元保存一份完整的 `<unit>.json` 文件；`per-record` 布局为每条记录保存一份带版本戳的文档。两种布局都以原子方式发布每个变更文件，领域层负责安排调用顺序。当运维方需要可检查文件且所选布局适合写入量时选择它；对于更大或高并发的数据则选择 SQLite。本后端只面向宿主侧，不贡献提示词、工具或 schema。

## 模型

- `single` 布局中内存中的单元状态具有最终决定权；每个写入原语都会通过临时文件写入 + fsync + 原子 `rename()` 替换重新发布整个文件。单元文件始终是完整的当前状态：可读性是该后端存在的理由，规模问题则属于 SQLite 后端。`per-record` 中目录树具有最终决定权：每次 `put`/`delete` 只重写一份文档，`loadAll()` 重读整棵树——一次写入绝不触碰同级记录。
- 缺失的 `single` 文件或 `per-record` 目录会作为空单元打开，并在第一次写入时物化。外来或无法解析的 `single` 文件以 `malformed-medium` 拒绝；已存版本与描述符不同时以 `version-mismatch` 拒绝（预发布立场，不迁移）。`per-record` 中畸形、不可读或版本超出接受集的文档按缺失记录读取——一份坏文档绝不砖化整个单元——`backupRecord` 则把该记录的文档移存为 `<key>.json.bak.<stamp>`，供领域的 `backup-and-skip` 策略使用。
- `per-record` 读取接受盖有当前版本或已声明 `compatibleVersions` 条目的文档；写入总是盖当前版本。空的 per-record 目录树只在旧式整体单元 `<unit>.json` 的单元名匹配且版本落在接受集内时从中引导一次；目录树中已存在任何文档都会抑制该引导。
- `per-record` 记录键必须匹配 `[a-zA-Z0-9_-]+`（键会成为路径段）；不安全的键在任何文件操作前被拒绝。`single` 键保持不透明。
- 跨调用的写入顺序属于调用方（领域层的写入链）；rename 原子地提交每次调用的内容，其后的目录 fsync 为尽力而为——该处失败仅削弱崩溃持久性，不拒绝写入。

## 配置

| Key | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `root` | string | 必填，无默认值（cwd 回退会让文件散落各处） | 保存单元文件的目录；按需以 `0o700` 创建 |

## 不变量

**运行时不变量：** 未发布配套入口。后端把每个域规格映射到一个根目录下的文件；布局与版本由后端规格断言，不存在第二个存储。

## 模型体验

### 已存领域记录

#### 模型看到什么

无。本后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据，只供宿主侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：本后端从不触碰实时请求前缀。

## 已知限制与暂缓事项

- Windows 持久性依赖 libuv 的 `rename()`（调用 `MoveFileExW` 并启用替换），没有显式 write-through 标志；追加日志分面落地时，计划把会话日志后端更严格的 Win32 write-through 发布辅助函数下移到此处（见 Agent Note 的迁移章节）。
- 没有跨进程写锁：两个进程写入同一根目录时，可能交错执行整文件替换（最后写入者胜出）。当前消费方采用单一宿主进程部署；多进程方案按 Agent Note 的范围外事项表暂缓。
