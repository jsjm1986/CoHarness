# Agent Note: 从 rc.2..v0.2.2-rc.3 吸纳的上游 fs 修复

Status: implemented

[English](2026-11-14-upstream-fs-sync.md) | 中文

三条适用的上游修复已移植；其余 fs 变更与新功能耦合，随 fs-patch/tool-executor 吸纳批次处理。

## 已应用

- **`~` 展开（`ae0dfd1003`、`32004176bf`）**——在 `fs-local/fsio.ts` 中新增
  `expandHomePrefix`，仅在 `resolve`/`lstat` 入口应用：请求的 `~`/`~/`
  （Windows 上含 `~\`）解析到宿主主目录，而 `~user`、后续 `~` 段与目录项
  名称保持字面含义。
- **glob 前缀剪枝（`12f63eaf89` + `b1c8c9bbbc` + `ef284800b9` +
  `e8bdbbe823` + `f9ef03834a`）**——当模式的每个目录段都是 VCS 元数据之外
  的普通相对名称且未提供 `path` 时，`buildGlobCommand` 发出有序的
  `--glob=!**` + `--glob={dirs}/` 剪枝对；8 KiB argv 预算使超大规模回退为原遍历。
- **read 指引措辞（`15c9e6006b`）**——在 `read` 工具的系统提示指引中点名
  sed/head/tail 与行区间。
- **可写根授权校验（`e6cd6fdc61`、`f8633966f5`、`41a1aa8a97`、
  `6b71dcad85`、`64ece4cac1`）**——已就位：PTC 批已将 sandbox roots/policy
  文件同步到 rc.3 状态（逐字节一致已验证）。

## 推迟到功能批

`fs-patch`、`apply_patch`、`ctx.fs` 的 `patchText`/`deleteFile`/`moveFile`
（本地均无这些 API）、ToolArgsError/FsError 重构与 mutation 默认值工作是一个
纠缠的功能集；patch-parser 二次方 trim 修复（`88f5aa1d43`）随 `fs-patch` 本体
落地。此处仅将 `SDK_RENDERERS`/`renderToolsSdk` 放宽到 `PtcProgramFormat` 以维持
PTC 批 `'script'` 格式可编译；感知 script 的渲染内容随 tool-executor-ptc 同步。

## 验证

`vitest run packages/fs/`：全部套件通过，包括移植的 home-prefix 矩阵
（78 测试，1 项 Windows 门控跳过）与真实 rg 剪枝断言。
