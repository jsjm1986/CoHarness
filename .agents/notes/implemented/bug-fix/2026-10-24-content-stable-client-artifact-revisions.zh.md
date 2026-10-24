# Agent Note: 内容稳定的 Client 产物 revision

Status: implemented

[English](2026-10-24-content-stable-client-artifact-revisions.md) | 中文

## Problem

相同 Client 代码在重建或复制到 release 时可能获得不同的文件系统时间戳。文件系统 revision 因此改变 immutable 脚本 URL，丢失浏览器缓存复用，并在重连后不必要地替换插件。仅入口字节无法标识懒加载 chunk 的修改。

## Decision

共享 Client 编译器在该包所有输出写完后，向每个入口附加一个 `dsh-client-artifact=v1` 尾注。SHA-256 摘要覆盖按文件名排序、以长度分帧的可执行兄弟文件名及精确 JavaScript 字节。调试 map 文件不参与可执行内容身份。构建记录在接受工作区输出前拒绝缺失、格式错误和不一致的标记。

Client Modules 对已捕获的入口字节（包含尾注）求哈希，生成 row 的 revision。Host 启动时不发现或读取懒加载兄弟文件。stat 基线继续检测 HMR 候选变化，并跳过未变文件。元数据变化而带标记字节相同时，只刷新基线，不替换响应 body、不重组图、不发布重建。入口与懒加载代码变化都会推进 revision。

未带标记的外部产物保留文件系统 revision，因为其构建器可能仅通过入口时间戳标识懒加载变化。保留的独立尾注格式错误或版本不支持时会明确失败。source-map 提供方式及其现有上一代限制仍遵循 [Client Modules](../../../../packages/client/modules/README.zh.md#known-limitations-and-deferred-work) 文档。[加载模型](../architecture/2026-07-23-client-plugin-loading-model.zh.md) 继续负责插件组合与生命周期。

## Alternatives considered

- 保留文件系统 revision，无法跨普通 release 复制识别可执行内容相等性。
- 仅对入口代码求哈希会漏掉只修改懒加载代码的情况；在 Host 对兄弟文件求哈希会为尚未打开的预览器增加启动 I/O。
- 对未带标记产物使用内容 revision，会静默破坏现有外部构建器的失效信号。

## Consequences

重复的相同输出保留资源 URL；真正变化的可执行输出使所属插件失效。Host 仅对已保留的入口字节增加哈希，不增加缓存、监听器或保留策略。替换 bootstrap 仍需刷新页面，release 身份继续阻止不同 release 的代码混用。

## Verification

Registry 用例覆盖复制与 touch 入口、保持图与响应发布不变、真实懒加载代码变化及旧式 revision。真实编译器 fixture 检查重复输出、仅修改懒加载代码、名称、许可证、source map 和动态执行。构建记录用例拒绝缺失、非法和陈旧标记。无密钥 Web profile 验证浏览器缓存复用，并在真实私有插件重建时保留已编辑设置；bootstrap 失败使用受控传输帧，不修改共享构建输出。
