# Agent Note: 个人文档发现是可选的 Agent Consumer

Status: implemented

[English](2026-09-01-personal-document-agent-tools.md) | 中文

## 问题

个人文档存储已经持久化命名文件，浏览器也可以管理这些文件，但 Agent 的模型侧工具集无法发现尚未附加的文件。提示词上下文 Consumer 只处理用户已经附加的文档 id，而文件系统搜索限定在编码工作区内，无法确认匹配文件属于用户的私有文档存储。

因此，当用户说“找到我的年度报告并总结”时，系统要么要求用户重新上传已经存在的文件，要么猜测绝对路径。这两种方式都让个人文档难以使用，并可能暴露主机相关路径或越过项目范围。

## 决策

`@deepseek-ai/dsh-tool-userdoc` 是现有 `ctx.userDocs` Service Definition 的模型侧 Consumer。它注册 `userdoc_list` 以发现有界元数据，并注册 `userdoc_read` 以读取有界的带行号 UTF-8 文本。存储、命名、文件系统包含性、HTTP 传输和浏览器管理仍分别由 `dsh-userdoc`、`dsh-userdoc-local`、`dsh-host-userdoc-http` 与 `dsh-client-ui-documents` 负责；Agent Consumer 不重复这些职责。

该 Consumer 作为插件行挂载在随附的 `standard`、`code` 和 `cordis` Agent preset 中。它注入 `tools`、`systemPrompt` 与 `userDocs`，增加一条稳定指引，告诉模型在要求上传前先列举文档，并且不会把完整目录放入系统提示词。这样 `code` preset 通过生成的 SDK 获得相同能力，不需要修改 agent loop。

`userdoc_list` 对名称和根相对 id 做筛选，支持文件夹和 offset 分页，使用确定性顺序，并省略所有主机绝对路径。`userdoc_read` 通过 `stat` 与 `openRead` 重新解析返回的 id，执行部署级字节和行数限制，在边界处保持 UTF-8 完整性，对格式错误的文本返回 `USERDOC_NOT_TEXT`；只有字节上限落在行与行之间时才报告继续读取的 offset，若落在行内则要求提高字节上限。两个结果在格式化后仍受字节上限约束，文档字节被视为不可信数据而不是指令。

该 Consumer 要求拥有 Agent，并在 Gateway 项目运行时以 `USERDOC_PERSONAL_SCOPE_UNAVAILABLE` 拒绝调用。项目 Agent 必须先获得经过明确认证的文档来源 Provider 才能访问个人存储；当前插件不会从共享运行时推断权限，也不会把用户私有路径复制到项目中。

## 模型侧行为

只有在 preset 插件行挂载期间，模型才会看到这两个只读 schema。当个人文档没有附加时，模型调用 `userdoc_list`，从返回结果中选择唯一的 `doc_id`，再调用 `userdoc_read` 后进行总结。列举页或完整行读取窗口达到上限时会给出明确的 offset 继续指引；如果字节上限落在行内则要求提高部署上限，存在多个匹配项时由用户选择，而不是任意挑选文件。

## 验证

`packages/attachment/tool-userdoc/tests/` 覆盖插件生命周期、schema、提示词指引、范围拒绝、输入验证、确定性格式化、UTF-8 与取消行为以及列举／读取执行路径，并达到每个源文件 100% 覆盖率。`examples/headless-agent/tests/userdoc-agent.snapshot.ts` 启动组装后的本地存储和 Consumer，在没有浏览器附件的情况下写入个人文件，并回放无密钥的列举后读取模型轨迹。

## 考虑过的替代方案

**把个人文档目录内联到每次系统提示词。** 不采用：目录大小和文件名会消耗 token，文件变化会使可复用的提示词前缀失效，而且用户询问无关问题时也会泄露私有元数据。

**复用 `glob`／`grep` 搜索主机文件系统。** 不采用：这些工具搜索编码工作区，会暴露部署相关路径，也无法证明结果属于已认证的个人存储。

**把列举／读取方法加入 Agent loop 或存储 Service。** 不采用：loop 应通过现有工具注册表调度能力，存储 seam 必须保持与格式和传输无关。独立 Consumer 可以明确每个插件的所有权。

**只要 `ctx.userDocs` 能解析，就从项目运行时暴露个人文档。** 不采用：服务存在不等于授权。跨范围访问需要 Gateway Provider 明确捕获 principal、范围和审计策略。

## 后果

标准用户流程变得直接：Agent 可以按名称查找并检查个人文档，不需要重新上传、绝对路径或向提示词注入目录。只读上限避免大工作区和大文件产生无界模型结果，稳定 id 让模型能够继续分页操作。

保存、编辑、删除、版本管理、内容索引和格式专用读取仍由独立 Consumer 负责。它们的审批、事件记录和授权规则可以独立演进，不必扩大这个只读包，也不会削弱个人／项目范围区分。定义好范围约定后，未来的已认证 Provider 可以复用这里的格式化和工具职责。
