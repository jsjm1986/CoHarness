# Agent Note：远程桌面管理面只存于 gateway admin 面

Status: implemented

[English](2026-10-20-remote-desktop-admin-surface-boundary.md) | 中文

## 问题

`ui-remote-desktop-admin` 向终端用户设置页注册了一个 `settings.section`：授权表、签发表单、revoke/setLevel 操作与审计尾部——与 gateway admin 面经 `RemoteDesktopPage`（端点、授权、审计）提供的管理功能完全重复。把它放进用户设置既在错误的受众面里复制了管理面，又把 admin 门槛的 `remoteDesktop/*` wire 调用暴露给永远过不了 `requireAdmin` 的用户，使该区块对非 admin 账号渲染出一套永远失败的控件。

## 决策

远程桌面管理有且只有一个家：gateway admin 面（`/admin` → Remote Desktop）。`settings.section` 贡献连同整个包一并移除——删除 `packages/client/ui-remote-desktop-admin`，摘掉其 `web-app` 组合项与清单依赖，清理或重生成所有列出它的注册表（coverage baseline、README Model Experience 契约、upstream-sync 清单、tsconfig paths/references、各生成编目）。终端用户保留经 `ui-remote-desktop` 侧栏 guide 的 consent → attach → RFB 流程；没有任何用户可操作能力丢失，因为被移除的区块执行的是经会话 wire 的管理员操作，而非面向用户的设置。

## 已考虑的替代方案

**保留包挂载但仅对 admin 主体可见。** 否决：用户设置里仍会挂着一个管理区块，且 gateway admin 页已以更完整的端点编辑器渲染同一批操作——同一决策的两个家必然分叉。

**摘挂载但保留包。** 否决：未挂载的插件是每个静态门都得继续搬运的死重；该能力的管理路径已由 `gateway/src/remote-desktop-service.ts` 持有，保留下来的代码没有独有价值。

## 后果

用户设置页不再列出远程桌面区块；管理员专用 admin 面。Wire 层 admin 方法（`grant`、`revoke`、`setLevel`、面向他人 principal 的 `listGrants`）仍由 Provider 的 `requireAdmin` 强制——移除区块改变的是呈现而非授权。[capability-seam note](2026-10-19-remote-desktop-capability-seam.zh.md) 继续持有授权/同意/附件设计；其延后工作列表不再点名已移除的包。

## 验证

摘掉挂载项后 `verify-cordis-config` 通过；web-app 组合 spec 在无该插件下正常启动；重生成 module graph、config catalog 与 composition-reference packages 表后，`grep -r remote-desktop-admin` 全树无存活引用。
