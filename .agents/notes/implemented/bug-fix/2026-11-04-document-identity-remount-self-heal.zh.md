# Agent Note: 文档身份库对 inode 可证的重挂载自愈

Status: implemented

[English](2026-11-04-document-identity-remount-self-heal.md) | 中文

## 问题

旧版（schema 2/3）以及未迁移的 schema-4 文档身份库在操作系统重挂载导致卷设备号变化后拒绝打开，尽管所有已记录的 inode 仍然匹配。`verifyLegacyStorage`、`bindStorageInside` 与私有 `domain.json` 标记都对无 volume 见证的记录要求设备号完全一致；只有离线 `recoverDocumentIdentityMount` 备份路径能归一化设备号，而它要求一份重启前的独立快照——实践中通常不存在。于是重启会把所有旧文档库锁死，使其永远到不了能迁移到 schema 4 并获取持久卷 UUID 的首次可写打开——一个 bootstrap 死锁。

## 决策

现在打开与变更路径在严格校验拒绝时尝试带验证的恢复：`verifyLegacyStorage(binding, recovered)` 与 `bindDomain` 的标记比较仅当所有已记录 inode 一致且当前描述符可读到持久卷 UUID 时才接受设备号变化。`recoverDomainMount` 将 v1 标记重写为携带已获取 UUID 的 v2；`recoverMount` 随后归一化记录的设备号并持久化 UUID，使该库在下一次打开后对未来设备漂移免疫。

- `identity.ts` — `verifyLegacyStorage(binding, recovered)` 对无 volume 的旧行接受 `recorded.inode === current.inode && current.volume !== undefined` 作为证明。
- `identity-storage.ts` — `recordedObject` 增加 `recovered` 设备容差；`bindDomain` 透传并把恢复过的标记重写为 v2；`recoverDomainMount(rootId)` 要求卷 UUID 可读且绝不初始化。
- `identity-fs.ts` — 旧版打开在 `DocumentIdentityConflict` 后以 `recovered` 重验 `verifyLegacyStorage`，在标记拒绝后走 `recoverDomainMount`。
- `mutation.ts` — 首次变更先试 `bindDomain` 再试 `bindStorage`，各自见证独立恢复；重入仅恢复标记。

## 考虑过的替代方案

- **所有重挂载都走离线验证恢复路径**输在被观察到的死锁：`recoverDocumentIdentityMount` 要求一份实践中几乎不存在的重启前独立快照，强制要求它只会让库继续锁死。
- **无卷 UUID 可读仍接受 inode 一致**落选：无法持久化 UUID 的库从归一化中得不到任何持久见证，因此无 UUID 主机维持严格拒绝。
- **无 inode 证明即接受设备漂移**落选：卷级克隆对任何带内检查都不可区分——无条件容忍会放行严格 schema 旨在拒绝的复制或克隆根。

## 后果

复制目录按定义得到全新 inode，因此 documents、files、state 与 database 四个见证的 inode 一致是本地可证的最强重挂载证据；以卷 UUID 可读性为恢复前提，保证被放行的库立刻获得严格 schema 所缺的持久见证。文件复制无法保留 inode，因此复制的根仍会被每个见证拒绝。离线 `recoverDocumentIdentityMount` 验证恢复路径不变，仍是 inode 不一致或主机无卷 UUID 时的唯一途径。恢复方法绝不创建标记、绝不接受变化的 inode，任何字节被归一化之前每个见证都按其自身证据独立重验。

## 验证

`mount-recovery.spec.ts` 覆盖 inode 可证的旧版重挂载在打开时自愈且历史保留、无卷证据拒绝、inode 变化拒绝；`mount-loader.spec.ts` 在 mock UUID 下通过真实 Loader 重放托管 provider 自愈。`identity-fs.spec.ts` 继续拒绝 schema 3 与 4 库的逐文件复制。
