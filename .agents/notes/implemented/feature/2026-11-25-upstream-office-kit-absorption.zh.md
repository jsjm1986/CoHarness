# Agent Note：上游 office-kit 吸纳并替代 office-to-pdf

状态：已实现

[English](2026-11-25-upstream-office-kit-absorption.md) | 中文

## 问题

上游 rc.3 用 `packages/document/office-kit` 替代 `office-to-pdf` 作为文档转换 seam，本地消费方（apiproxy workspace-files、gateway launch-stamp、skill-office）仍在使用旧包。上游 kit 还携带本 fork 不具备的面——Remote 端点经上游 `dsh-api-workspace-files` 服务解析 Session 文件，该服务本地不存在。

## 决定

吸纳上游 `packages/document/office-kit` 作为 `ctx.officeKit` Host 服务，替代 `office-to-pdf`，重接全部消费方，libreoffice-kit 升级至 `0.2.3`，并放弃上游独有的 Remote 端点、改用本地 apiproxy seam。

## 后果

- **`render`/`generation` Remote 端点缺失**——本地 Session 文件授权位于 `host/apiproxy` 的 workspace-files 域，以同形 `OfficeKitRequest` 调用进程内 `officeKit.convert()`；`remote.spec.ts` 与 `RenderedDocumentBytes` 随端点移除。
- **`fontMetadataCacheDirectory` 保留在 `Config`**——本地 gateway 按运行时下发字体缓存目录（`HGW_OFFICE_FONT_METADATA_CACHE_DIR`）；kit `0.2.3` 仍接受该选项。
- **`tool-office` 已在后续 executor-seam 批吸纳**——其真实组合测试需要先落地的 `dsh-tool-executor-native`/`-ptc` 与 `dsh-tool-testkit`。
- libreoffice-kit `0.2.3` 已将 `fontkit` 声明为依赖，`0.1.1` 死导入 patch 不再携带；`0.1.x` 版本钉仅保留于仍在使用的 `skill-office`。

## 备选方案

- **保留上游 Remote 端点**——拒绝：它们经上游 `dsh-api-workspace-files` 服务解析 Session 文件，本 fork 无该服务；apiproxy workspace-files 域已提供等效的进程内授权。

## 验证

- `pnpm exec vitest run packages/document/office-kit` —— 120 个测试通过。
- `packages/host/apiproxy` typecheck 干净；`workspace-office.spec.ts` + `plugin-administration.spec.ts` —— 8 个通过。
- `gateway/tests/instances.spec.ts` —— 111 个通过（launch-stamp office-kit patch）。
- `verify-md-links`、`verify-translation-pairing`、`verify-cordis-config`、`gen-cordis-catalog --check`、`verify-plugin-packages` —— 全部通过。
