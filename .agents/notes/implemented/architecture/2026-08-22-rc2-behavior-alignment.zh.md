# Agent Note: RC2 行为对齐但不合并仓库历史

Status: implemented

[English](2026-08-22-rc2-behavior-alignment.md) | 中文

## Problem

CoHarness 与上游 DeepSeek Harness RC2 代码线没有共同仓库历史，因此整体 merge 或盲目 cherry-pick 不能建立兼容性。此前的本地对齐提交还缺少若干 RC2 的用户可见和运行时行为：确定性的图片准入、DeepSeek Files 请求路径、缺失资源状态处理以及受发布控制的文档发布。

## Decision

CoHarness 以 `dsh-v0.1.1-rc.2` 的用户可见、运行时、wire、安全和发布语义为对齐基准。每项适用行为都在本地实现或通过明确适配器实现，并配套聚焦测试以及组装后的类型和文档检查。不整体合并仓库历史，因为两棵代码树具有不同的产品扩展和所有权边界。

图片路径现在包含确定性 canonical 编码、normalization 和 admission、request-image budget、metadata/animation 处理以及带归一化尺寸信息的 `read_image`。DeepSeek 图片请求使用 Files API，并提供持久上传缓存、file id 解析和失效、过期文件重试、独立的 Files 与 stream 超时，以及 Files 无法解析时的 inline fallback。配额回收会在每个远端文件成功删除后，立即按精确 file id 删除本地上传索引，因此删除失败或取消时不会清除后续记录。静态前端缺失资源返回 `404`，显式 index 入口仍正常提供。文档部署改为手动触发，并在发布前基于完整 tag 历史执行 release verification。

CoHarness 自有的 user document、项目空间、多人协作和 ACL、UI 修改以及默认不限制单文件大小的文档上传策略继续保留。这些是独立的产品行为，不能替代 DeepSeek Files 管线。文档上传限制仍可为空：部署可以配置有限值，默认不施加单文件大小限制。

现有图片相关 Agent Note 继续负责更窄的限制和编码决策：[Web 图片准入](../bug-fix/2026-07-29-atomic-web-image-admission.zh.md)、[request-image payload 限制](../bug-fix/2026-08-18-request-image-payload-bound.zh.md)和 [read-image 尺寸](../feature/2026-08-10-minimal-read-image-tool.zh.md)。本 note 负责跨模块的 RC2 对齐规则，以及上游兼容行为和 CoHarness 扩展之间的边界。

## Alternatives considered

**合并或 cherry-pick 上游 RC2 历史。** 不采用，因为两个仓库没有共同祖先，本地产品还有独立的 Gateway、项目空间、协作、user document 和 UI 改动。历史操作要么失败，要么在没有证明行为等价的情况下覆盖所有权决策。

**逐文件照搬上游。** 不采用，因为包边界和本地 provider 不同。验收标准是可观察行为等价或更强，而不是源码布局相同；只要测试覆盖相同的失败和 wire 场景，本地适配器就是允许的实现方式。

**把 user document 当成 DeepSeek Files 实现。** 不采用，因为 user document 是项目空间存储和对话功能，而 Files API 上传属于 provider 请求准备。分开维护可以保留两者不同的生命周期、配额和失败语义。

**只凭聚焦测试就宣称完美兼容。** 不采用，因为 provider 行为、发布构建、lint、文档门禁和部署验证仍需证据。只有相关门禁通过后，项目才可以声明 RC2 行为对齐，并且仍需说明有意保留的 CoHarness 扩展。

## Consequences

代码库拥有明确且可测试的兼容目标，同时不牺牲本地产品行为。后续同步上游时按行为类别和验收测试比较，而不是按提交名称判断。Files API 失败可以回退到 inline 图片，取消请求不会被当成可重试的 provider 失败；前端未知资源不再得到成功的 SPA 文档；文档发布不能由任意分支 push 触发。

本决策不将全仓包版本从 `0.1.1-rc.1` 提升到 `rc.2`，不发布 release、不推送分支、不合并 PR，也不部署生产。版本和部署仍是完整仓库门禁通过后的独立发布动作。
