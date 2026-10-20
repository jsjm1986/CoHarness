# Agent Note: 远程桌面文件状态事务化重载与能力失败保持 wire 错误码

Status: implemented

[English](2026-10-20-remote-desktop-file-state-and-wire-error-repairs.md) | 中文

## 问题

文件支撑的状态路径存在四个相互独立的完整性缺陷。`syncEndpoints` 在解析前就记录了端点文件的 mtime、在校验行之前就清空了存活映射，因此一次畸形的外部写入会永久清空端点表并消费掉该修订——之后的每次调用看到相同的 mtime，静默返回空映射。`VncGrantStore` 重复了同一模式：`refresh` 在 `reload` 成功前提交 `seenMtimeMs`，`reload` 在解析完所有行之前清空映射，而 `persist` 把自身写入的 mtime 预先标记为已见，遮蔽了落在同一刻度的外部重写。端点键在两处用字符串拼接生成，于是 `('ab','c')` 与 `('a','bc')` 共享同一键——同意或端点解析可能在不同的桌面之间串越。四个控制器方法（`listGrants`、`grant`、`setLevel`、`revoke`）未翻译 Provider 拒绝就返回，`RemoteDesktopError` 到达客户端时缺失标签页主体赖以分支的 `details.code`。而 `VncAuditLog.open` 对尾部行裸 `JSON.parse`，崩溃截断的最后一行会让整个能力在装载时失败。

## 决策

两条重载路径现在事务化提交：文件被完整读入并解析到临时映射后才触碰任何内存状态，仅在成功时替换既有映射，mtime 仅在解析提交后消费——畸形写入在每次调用时响亮失败直至有效文件落地，先完成的读取继续由最后一份完好数据服务。`parseEndpointsFile` 在去重前校验 JSON 语法、`endpoints` 数组以及每行 `nodeId`/`desktop`/`host`/`port` 形态，以点名文件的 `REMOTE_DESKTOP_TRANSPORT` 失败。`endpointKey` 是唯一的键构造器，把 `[nodeId, desktop]` 序列化为 JSON，任意两个不同目标都不会碰撞；`persist` 不再预先标记自身 mtime，外部重写必被重读。`listGrants(attachable)` 额外要求目标已配置端点——引导入口不会列出 attach 会在拨号时拒绝的授权。全部八个控制器 Remote 方法把能力拒绝走 `translate`，`RemoteDesktopError.code` 以 `remote-desktop/failure` 的 details 到达客户端。`VncAuditLog.open` 以一次 `logger.warn` 丢弃不可读尾行而非整体失败；审计契约保留可读行。

## 考虑过但未选

**把缺失或损坏的端点文件按空表处理。** 否决：损坏的部署文件是管理员必须看到的配置错误，静默提供空表会把写入错误变成无诊断的 attach 拒绝。

**用内容哈希代替 mtime。** 否决，收益不成比例：mtime 粒度是仅剩的竞态，它无法遮蔽发生在已观测 stat 之后的变更，而为每次调用读取的 KB 级文件做哈希收益甚微。

**把能力码映射为按方法的 wire 码。** 否决：`remote-desktop/failure` 在 `details.code` 中携带能力码本就是客户端分支的契约；本修复是恢复该契约而非扩写 wire 词汇。

## 后果

一次坏的 `endpoints.json` 或 `grants.jsonl` 写入降级为响亮且重试的 `REMOTE_DESKTOP_TRANSPORT` 失败，而非静默丢状态；两份存储在下一次有效写入时无重启恢复。`attachable` 列表现在只描述真实可挂接的目标。客户端对每个管理方法拒绝都能拿到稳定的 `details.code`。审计追加中途崩溃不再阻塞 Provider 启动。REAL-composition 测试经 Loader/Include 从测试用 `cordis.yml` 启动 Provider——覆盖组合、外部文件收敛与真实 socket 上的过滤流——`controller.spec.ts`、`audit.spec.ts` 以及 `grants.spec.ts`/`service.spec.ts` 的新增用例分别钉住各项修复行为。
