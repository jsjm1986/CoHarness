# Agent Note: 同源的文档原生 PDF 嵌入

Status: implemented

[English](2026-10-23-native-document-pdf-framing.md) | 中文

## 问题

文档库通过 iframe 嵌入已认证的 PDF 内容。禁止所有 frame 祖先的响应策略会在原生 PDF 阅读器加载前拒绝这一预览。同一组文档路由也服务可执行的 HTML 与 SVG，因此允许所有内联响应被嵌入会扩大无关格式的权限。

## 决策

只有内联且服务端声明的媒体类型恰为 `application/pdf` 的响应允许同源祖先。[文档 HTTP 参考](../../../../packages/host/userdoc-http/README.zh.md#known-limitations-and-deferred-work)拥有响应规则。Host 处理器与 Gateway 运行时转发器均应用该规则；[本地 broker](../architecture/2026-10-15-gateway-local-document-broker.zh.md)复用同一 Host 处理器。该改动只调整响应的嵌入策略，不改变字节流、账户与运行时身份检查、成员权限或 UI 已认证的内容 URL。

CSP `sandbox` 指令仍不带许可项。Chromium 的[原生 PDF 测试](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/pdf/pdf_extension_test.cc#506)区分了该响应指令下的原生 PDF 处理与被 `frame-ancestors` 阻止的 iframe 嵌入。这不授权添加 `allow-scripts`、`allow-same-origin` 或任何 iframe sandbox 豁免。HTML、SVG、文本和未知类型保留现有处理。

存储服务根据文件名推导媒体类型，不验证文档结构。因此 `nosniff`、声明的 PDF 响应类型和原生阅读器的 PDF 解析器需要共同保留：改名的 HTML 文件进入 PDF 阅读器的失败状态，不进入应用的 HTML DOM。Chromium 的[安全指导](https://chromium.googlesource.com/chromium/src/+/main/content/SECURITY.md#mitigating-factors)另外说明 PDF 渲染器隔离；响应 CSP sandbox 与浏览器进程沙箱不是同一机制。

## 考虑过的替代方案

**移除响应 CSP 或放宽全部内联类型。** 这会给无关上传标记内容授予原生 PDF 路径不需要的权限。

**预先移除 PDF 的 CSP sandbox。** 原生 Chromium 验收在保留该指令时成功。没有已证实的兼容问题，无需再移除一项限制。

**将完整文档读入 Blob，或导入另一个 UI 插件的渲染器。** 两者分别引入文档缓冲或新的跨插件运行时依赖，只为修正响应策略不匹配。当前已认证的流式 URL 已经提供原生 PDF 内容。

## 验证

[可运行 fixture](../../../../packages/host/userdoc-http/tests/native-preview-fixture.ts)只在临时根目录创建合成文档，并在随机回环端口挂载生产 Connection、文件系统存储与文档 HTTP 所有者。另一个端口提供不同源的父页面。原生 Chrome 显示有效 PDF，通过 `frame-ancestors 'self'` 拒绝该不同源嵌入，将改名的 HTML 文件判为无效 PDF，并继续阻止 HTML/SVG frame，脚本执行哨兵保持不变。

完整 Host 快照固定 PDF、改名 PDF、HTML、SVG、文本、HEAD、未认证访问、完整流式字节和 attachment 下载行为。Gateway 转发矩阵将 lease 保留到流结束，并检查不支持的 MIME 值。本地 broker 测试还从另一个账户请求同一文档 id，确认没有文档字节返回；缺少协作授权或不是项目成员时，在读取之前拒绝。

## 影响

文档库的原生 PDF iframe 可以从同源加载，无关上传格式保留原有限制。直接下载保持 attachment，不引入页面级文档缓存。浏览器保留原生 PDF 能力与错误处理；嵌入式 PDF 支持仍属于浏览器行为，不新增应用渲染器。
