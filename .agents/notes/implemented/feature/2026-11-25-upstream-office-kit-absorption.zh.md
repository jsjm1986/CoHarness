# Agent Note: 上游 office-kit 吸纳并替代 office-to-pdf

[English](2026-11-25-upstream-office-kit-absorption.md) | 中文

Status: implemented

## 决策

吸纳上游 `packages/document/office-kit`（dsh-v0.2.2-rc.3）作为 `ctx.officeKit` Host 服务，替代 `office-to-pdf` 并重接全部消费方。libreoffice-kit 升级至 `0.2.3`。

## 移植适配

- **移除 `render`/`generation` Remote 端点**——它们经上游 `dsh-api-workspace-files` 服务解析 Session 文件，本 fork 无该服务。本地 Session 文件授权位于 `host/apiproxy` 的 workspace-files 域，以同形 `OfficeKitRequest` 调用进程内 `officeKit.convert()`；`remote.spec.ts` 与 `RenderedDocumentBytes` 随端点移除。
- **保留 `fontMetadataCacheDirectory` Config 字段**——上游 office-kit 未暴露，但本地 gateway 按运行时下发字体缓存目录（`HGW_OFFICE_FONT_METADATA_CACHE_DIR`）;kit `0.2.3` 仍接受该选项。
- **未吸纳 `tool-office`**——其真实组合测试依赖上游 `dsh-tool-executor-native`/`-ptc` 与 `dsh-tool-testkit`，本地不存在；随 tool-executor 批处理。
- libreoffice-kit `0.2.3` 已将 `fontkit` 声明为依赖，`0.1.1` 死导入 patch 不再携带；`0.1.x` 版本钉仅保留于仍在使用的 `skill-office`。
- 上游 README 已修改：Remote 端点段落改写为 apiproxy seam，失效的 `apps/desktop` 链接重定向，`tool-office` 引用标注为后续批次。

## 验证

- `pnpm exec vitest run packages/document/office-kit` —— 120 个测试通过。
- `packages/host/apiproxy` typecheck 干净；`workspace-office.spec.ts` + `plugin-administration.spec.ts` —— 8 个通过。
- `gateway/tests/instances.spec.ts` —— 111 个通过（launch-stamp office-kit patch)。
- `verify-md-links`、`verify-translation-pairing`、`verify-cordis-config`、`gen-cordis-catalog --check`、`verify-plugin-packages` —— 全部通过。
