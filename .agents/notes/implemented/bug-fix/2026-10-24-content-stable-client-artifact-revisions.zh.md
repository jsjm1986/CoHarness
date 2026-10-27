# Agent Note: 内容稳定的 Client 产物 revision

Status: implemented

[English](2026-10-24-content-stable-client-artifact-revisions.md) | 中文

## Problem

相同 Client 代码在重建或复制到 release 时可能获得不同的文件系统时间戳。文件系统 revision 因此改变 immutable 脚本 URL，丢失浏览器缓存复用，并在重连后不必要地替换插件。仅入口字节无法标识懒加载 chunk 的修改。所有懒加载 chunk 共用 owner revision，也会使未变的预览器因无关入口代码修改而失效。

## Decision

共享 Client 编译器在该包所有输出写完后，向每个入口附加一个 `dsh-client-artifact=v1` 尾注。SHA-256 摘要覆盖按文件名排序、以长度分帧的可执行兄弟文件名及精确 JavaScript 字节。调试 map 文件不参与可执行内容身份。构建记录在接受工作区输出前拒绝缺失、格式错误和不一致的标记。

位于其前的版本化 `dsh-client-chunks` 表记录排除生成的独立调试尾注行后的各 chunk 可执行摘要。类似指令的字符串、块注释及可执行代码行分隔符仍属于可执行字节；摘要计算与 HTTP 组装均保留它们。尾部识别排除生成 URL 中的空白、引号、反引号、反斜杠和星号，因此不会吞掉多行字面量或注释的闭合语法。未识别的尾部保持原字节。Host 将捕获的表投影为可选图行元数据，并在首次懒读取时核对可执行字节。chunk 脚本与 map 尾注使用 chunk revision，同时继续接受当前 owner revision URL，兼容旧 Client。旧 Host 和无表产物继续使用 owner revision URL。未知、过时或不精确的 URL 会被拒绝，未完成的磁盘重写不能把新可执行字节发布到旧 immutable URL。chunk body 失败时，只移除 registry 仍持有的同一个响应计划；后续显式请求可读取已恢复的字节，成功响应保持不可变，不执行自动重试。

Client Modules 对已捕获的入口字节（包含尾注）求哈希，生成 row 的 revision。Host 启动时不发现或读取懒加载兄弟文件。stat 基线继续检测 HMR 候选变化，并跳过未变文件。元数据变化而带标记字节相同时，只刷新基线，不替换响应 body、不重组图、不发布重建。入口与懒加载代码变化都会推进 revision。

owner revision 继续负责 factory 替换。chunk 表只与匹配的 owner revision 一起使用；仅含重建信息的帧会撤销旧 chunk 元数据，直到完整图提供当前身份。每个 chunk 的过时代际清理由一次传输结算负责，所有等待者都在读取 factory 或导出前等待它。旧调用者的 continuation 无法在另一等待者恢复后删除替代内容。下一代可以再次执行相同的已缓存 chunk URL，将 factory 绑定到当前 owner。

未带标记的外部产物保留文件系统 revision，因为其构建器可能仅通过入口时间戳标识懒加载变化。保留的独立尾注格式错误或版本不支持时会明确失败。source-map 提供方式及其现有上一代限制仍遵循 [Client Modules](../../../../packages/client/modules/README.zh.md#known-limitations-and-deferred-work) 文档。[加载模型](../architecture/2026-07-23-client-plugin-loading-model.zh.md) 继续负责插件组合与生命周期。

## Alternatives considered

- 保留文件系统 revision，无法跨普通 release 复制识别可执行内容相等性。
- 仅对入口代码求哈希会漏掉只修改懒加载代码的情况；在 Host 对兄弟文件求哈希会为尚未打开的预览器增加启动 I/O。
- 对未带标记产物使用内容 revision，会静默破坏现有外部构建器的失效信号。
- 未变 chunk 保留 owner revision 会丢失可复用的预览器下载；将调试 map 纳入入口或 chunk revision 的哈希，会让纯诊断变化使可执行资源失效。

## Consequences

重复的相同输出保留资源 URL；真正变化的可执行输出使所属插件失效。仅修改 owner 时，未变 chunk 保留 URL。Host 仅对已读取的入口和已请求 chunk 字节求哈希，不提前扫描兄弟文件，也不额外保留产物代际。并发代际会等待现有 chunk 传输结算，再采用另一 factory。替换 bootstrap 仍需刷新页面，release 身份继续阻止不同 release 的代码混用。

## Verification

Registry 用例覆盖复制与 touch 入口、保持图与响应发布不变、真实懒加载代码变化、旧式 revision、精确 chunk URL、延迟文件读取及拒绝不匹配的磁盘字节。Loader 屏障覆盖 URL 未变时多名旧代与当前代等待者的失效竞争、变化代码的延迟到达，以及仅重建信息帧撤销元数据。真实编译器 fixture 检查重复输出、仅修改懒加载代码、名称、许可证、source map 和动态执行。构建记录用例拒绝缺失、非法和陈旧标记。无密钥 Web profile 验证浏览器缓存复用，并在真实私有插件重建时保留已编辑设置；bootstrap 失败使用受控传输帧，不修改共享构建输出。
