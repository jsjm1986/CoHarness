---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-userdoc

[English](README.md) | 中文

用户文档能力接缝。`ctx.userDocs` 在当前运行时的文档工作区内存储文件和文件夹，并返回携带真实绝对路径的引用。agent 可用自己的文件系统和 shell 工具访问这些路径，因此模型不需要学习单独的取回通道。

这与 [`dsh-attachment`](../attachment/README.zh.md) 刻意相反——后者的对象是内容寻址的、私有的，且对文件工具不可见。两个边界并存：图片继续走附件路径，因为提供方需要把字节内联进请求；文档保留文件系统路径，因为 agent 会像读任何其他文件一样读它。

`resolveTarget` 是显式步骤，而不是藏在 `save` 内的默认逻辑：它净化客户端给出的名称，在文档根目录内解析所选文件夹，并返回 `save` 将创建的精确路径。调用方先解析，再把字节流交给 `save`，因此在写入任何字节之前就已决定准入和包含关系。设置有限的 `maxFileBytes` 时，`save` 按实际收到的字节执行该限制；使用 `null` 时不限制单个文档大小。写入失败不会留下残留文件。

同一个 seam 也负责可续传上传会话。Provider 创建不透明会话，接收按顺序且经过范围校验的分片，验证每个分片和最终文件的 SHA-256，并且只在完整文件验证后发布 `UserDocRef`。会话状态由 Provider 持有，浏览器永远不会看到临时路径。已认证的服务端通过独立于浏览器元数据的参数提供 `UserDocUploadOwnerId`。每次续传操作都必须携带发起者身份；身份缺失或不匹配时返回 `DOCUMENT_UPLOAD_NOT_FOUND`。无身份的独立组合只能访问无身份会话。

`listDirectory` 返回一个文件夹的直接子项，`list` 则保留提示附件和旧消费方使用的递归文档视图。`listDirectoryPage` 与 `listTrashPage` 为大型工作区提供有界、可筛选的游标分页。`createDirectory`、`renameDirectory` 与 `removeDirectory` 管理普通文件夹；根目录不能重命名或删除，非空文件夹也不能删除。`move` 接受文档 id 与目标文件夹 id，绝不替换同名项。`listTrash`、`trash`、`restore` 与 `purge` 暴露由提供方持有的可恢复生命周期；保留期限和物理清理由提供方策略决定。文件夹和文档 id 都是根相对的不透明值；提供方每次进入文件系统前都会重新验证。

`UserDocRef.identity` 和回收站身份字段对先前序列化的引用保持可选。`UserDocIdentity` 记录实例、修订号和原始创建者来源；`UserDocSelection` 与 `UserDocTrashSelection` 指定预期版本和操作。路径仍是普通文件地址，创建者来源不能代替当前所有权检查。浏览器安全的 `/identity` 入口导出 `decodeUserDocIdentity`，不携带 Cordis 服务。它校验持久化或传输的元数据，只返回已知字段；提供了无效身份时必须拒绝，不能当作无身份引用处理。

`mediaType` 按原样记录，从不校验、解析或据此分派。这里没有格式白名单。harness 接受用户上传的任何内容，并让 agent 判断文件是什么；服务端解析、文本抽取和缩略图生成按设计不属于该边界。

存储不是内容寻址的，因此字节完全相同的两次上传就是两个文件、两个标识符。删除其中一个不会影响另一个，这符合用户对自己目录中文件的预期。

个人存储与项目存储属于隔离的运行时。Gateway 文档 broker 可以在任意两个已授权作用域之间复制快照，包括项目到项目，但不会让文档 id 或路径跨运行时可移植；目标存储会重新生成 id 和名称。组织级元数据目录记录所有权、快照谱系、重试和审计操作，文件字节仍留在运行时存储中。

提供方适配器可以在不依赖 Context 的列表实现上复用 `defaultUserDocDirectoryPage` 和 `defaultUserDocTrashPage`，分页与验证保持 `UserDocStore` 默认行为。`USERDOC_ERROR_CODES` 和 `userDocErrorStatus` 定义共用的稳定错误码及 HTTP 映射，包括权限拒绝、待完成请求达到上限和传输元数据格式错误。

`UserDocScope.nodeId` 独立于 Runtime 标识电脑本地存储，`nodeName` 仅用于显示。`/identity` 中可在浏览器使用的 `userDocLocationUrl` 将文档路径绑定到该位置，并将受管总览及复制操作路由至 Gateway。服务端重新检查当前账号、电脑和项目权限；位置描述本身不授予权限。参见[浏览器文档参考](../../../gateway/docs/node-agent/browser/README.zh.md)。

## 概述

使用 `dsh-userdoc` 作为文档接缝：`ctx.userDocs` 把文件与文件夹存入运行时的文档工作区并返回携带真实绝对路径的引用，代理因此用普通文件系统与 shell 工具即可读取文档。它与 `dsh-attachment` 有意相反——后者的对象内容寻址、对文件工具不可见；图片走附件路径，文档走文件系统路径。

## 目录

- [模型体验](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

经由宿主提示词组装消费方间接产生影响；文档以内联文本还是可读取路径到达模型由该消费方决定，本接缝只提供引用与内联大小阈值。

#### KV Cache 影响

无直接失效；消费方负责请求前缀的任何变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待完成工作

- **没有业务配额记账** —— Provider 可以不限制单文件大小，但具体 Provider 仍必须负责磁盘可用空间和临时会话安全。
- **`list` 只遍历一个文档根目录** —— 没有索引或跨根视图，因此递归消费方会完整扫描很大的工作区。
- **读取时不做内容校验** —— 与内容寻址的附件路径不同，文档是普通文件，任何拥有文件系统访问权的主体都可能在上传后修改它，而 `bytes` 是上传时记录的长度。
- **快照复制不同步** —— 跨作用域复制是单向操作，目标文件提交后与源文件相互独立。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
