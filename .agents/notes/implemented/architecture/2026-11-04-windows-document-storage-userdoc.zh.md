# Agent Note：Windows 文档存储与 userDocs 运行时链路

状态：已实现

[English](2026-11-04-windows-document-storage-userdoc.md) | 中文

已在 `windows-vps-47` 生产节点验证（Runtime generation 43，release `coharness-full-real-20261104-r50-winexec`）。

## 问题

`userDocs` 无法在 Windows 激活，阻塞所有注入它的 agent 预设（`standard`、`cordis`、`ptc`）。四个 POSIX 专属假设逐段断链：

1. `gateway/src/document-storage.ts` 要求 `process.getuid()`，用 `uid`/`mode` 判定私有/受保护目录。
2. `gateway/src/document-scope-storage.ts` 用同样的 `uid`/`mode` 校验 scope 记录。
3. `gateway/src/launcher.ts` 只给 Runtime 子进程设 `HOME`，但 Windows 上 Node 的 `os.homedir()` 读 `USERPROFILE`——Runtime 的 `~/documents` 展开到 SYSTEM profile，而 Gateway 通告的是属主根，报 `Document service root does not match this runtime`。
4. `packages/attachment/userdoc-local/src/identity-storage.ts` 要求持久 marker 带 `volume`；Windows 的 `persistentObject()` 无卷标识，所有 Windows 写出的 marker 重开都报 `belong to another metadata domain`。

## 决策

- `gateway/src/node-private-file.ts`
  - 新增 `protectedDirectoryState()`——Windows 判定走 PowerShell 探针：零条非 `InheritOnly` 的 Deny 规则 + 零条向属主/LocalSystem(`S-1-5-18`)/Administrators(`S-1-5-32-544`) 之外 SID 授予修改类权限（`WINDOWS_MODIFY_RIGHTS_MASK`：Delete、DeleteSubdirectoriesAndFiles、ChangePermissions、TakeOwnership、WriteAttributes、WriteExtendedAttributes、GENERIC_ALL、GENERIC_WRITE）的 Allow 规则。`InheritOnly` ACE（如 `CREATOR OWNER` 模板）跳过——它们只约束未来子对象，对本目录无效，与 POSIX `mode & 0o022` 祖先检查所见一致。创建类权限（CreateFiles/CreateDirectories）同理保持无害。
  - `tightenPrivateFileAcl` 对目录输出可继承规则（`ContainerInherit,ObjectInherit`）——没有可继承 ACE 时子对象回退到创建者 token 默认 DACL，SYSTEM 服务 token 下会授予大量无关服务 SID。
- `gateway/src/document-storage.ts`
  - `privateDirectory`、stateRoot 检查、祖先保护遍历全部加 Windows 分支，复用 `privateDirectoryState`、`protectedDirectoryState`、`tightenPrivateFileAcl`；POSIX 逻辑不变。Windows 下 `owner` 可为 undefined。`DirectoryIdentity` 保留原始 `stat` 供判定读取 `isDirectory()`/`mode`。
- `gateway/src/document-scope-storage.ts`
  - `privateJson` 改用 `privateFileState`——scope 记录的属主独占判定统一走跨平台谓词，不再 POSIX 限定。
- `gateway/src/launcher.ts`
  - Runtime 子进程 env 在 win32 下同时设 `USERPROFILE` 与 `HOME`，使 `os.homedir()` 解析到属主家目录，`expandHomePath('~/documents')` 与 Gateway 通告根一致。
- `packages/attachment/userdoc-local/src/identity-storage.ts`
  - `recordedObject()` 仅在任一侧携带 `volume` 时才比较卷标识；Windows marker 用 device+inode 校验，POSIX v2 marker 保留卷要求。

## 考虑过的替代方案

用 POSIX 模式判断 Windows 目录会漏掉其他账号的 ACL 写权限。Runtime 自行解析用户目录也可能打开另一份文档。Gateway 和 Runtime 都要核对账号和文件系统对象身份。

## 后果

已在生产路径验证，记录于此避免下个 release 重踩：

- `organization-model-credentials.key` 必须在所有服务 `resolveManagedCredential` 的 Gateway 间一致；节点自生成密钥无法解密中心签发的密文（`Decipheriv.final` AEAD 失败 → 对 runtime 返回 HTTP 500）。
- `org-deepseek-official` 用 `driver: "pi-ai"`：缺 `@earendil-works/pi-ai` 时 `llm-pi-ai` 导入失败，`routeServed()` 以 `model-unavailable` 拒绝 `session.prompt`。
- pnpm patched 依赖物化为 `*_patch_hash=*` `.pnpm` 目录，与未打补丁的 `pnpm install` 布局不同——release 打包必须带上它们；且 Windows 上 tar 解出的指向目录的 file-type symlink 必须转 junction，否则 `stat()` EPERM。

## Windows 端到端验证

- `standard`、`cordis`、`minimal`、`ptc` 预设 `session.create` 全部成功。
- `session.prompt` → 经 `org-deepseek-official`（pi-ai 驱动，本地 Gateway 解密受管凭证）真实 DeepSeek 往返 → `turn/end completed`。
- `session.history` 返回持久化记录。
- 断点续传协议（`POST /api/documents/uploads` → 带 `x-dsh-chunk-sha256` 的 chunk PUT → `complete`）把文件落到 `C:\harness-users\admin\home\documents\`，对象字节留在 ACL 私有存储中。
- `userdoc_list`/`userdoc_read` 工具向 agent 返回已上传文档；私有根、scope bindings、retired 存储全部通过 Windows ACL 私有判定。

## 遗留缺口

- `session-telemetry-otel` 需要节点上配套的 `@opentelemetry/exporter-logs-otlp-http` `.pnpm` 载荷（文件就位后模块即可解析）。
- 尚无原生 Windows CI 车道覆盖这些探针；PowerShell ACL 帮手目前只经生产部署验证。
