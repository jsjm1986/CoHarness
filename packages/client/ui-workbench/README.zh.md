# @deepseek-ai/dsh-client-ui-workbench

[English](README.md) | 中文

此 Cordis 浏览器插件在一个多面板对话工作台中展示最多四个已有 Workspace Session。它负责 Workspace／会话选择器，以及面板选择、顺序、比例和模式切换的操作；它消费 `conversationViewport` 能力，通过 ui-conversation 声明的 slots 贡献工具栏、空状态和面板头。

插件不导入 ConversationRoot、ChatView、InputBar 或其他呈现实现。conversation slot 的拥有者通过显式 SessionProvider 渲染各面板，因此每个面板都从同一对象层获取独立的 Session 标准 props、会话 store、projection 和注入操作。

## 组合

`apply()` 等待 `conversationViewport`，通过 `ctx.slots.inject()` 注册工作台控件。提供方拥有有界 Session stage 集合；卸载工作台会释放额外历史窗口，保留普通当前会话视图。Gateway 返回经过 ACL 过滤的账户级目录，选中的项目运行时使用独立的目标传输和 principal assertion；Session JSONL、持久化格式和 Collaboration 授权语义保持不变。

## 视图状态

提供方在浏览器本地 `dsh.conversation.workbench.v1` 中仅保存模式、Session ID、活动 ID 和面板比例。恢复的 ID 在 staged 和渲染前使用账户目录及目标运行时可见性校验。重复 ID 只聚焦已有面板；第五个 ID 被拒绝，不会自动替换面板。

桌面使用等宽或按比例排列的列；放不下四列时使用两行。每个桌面面板最小宽度为 360px，分隔线支持鼠标、触控和方向键调整，面板可放大或通过菜单移动。工具栏可选择已有对话，或在明确选择的 Workspace 中新建会话；失败会显示原因，达到上限时需要主动选择替换。用户可返回原单会话模式。窄屏每次只渲染活动面板，其余 staged Session 对象继续接收正常运行时更新。关闭面板只移出工作台，始终不会停止 Session。

会话选择器排除已归档的根会话和未选中的空白草稿。个人记录使用侧栏相同的 `workspace.list.archivedSessionIds` 快照；项目记录排除归档索引中的条目，打开目标时再次检查其实时 Workspace 归档集合。账户目录响应是候选列表的依据，不会用被排除的本地记录补全。

## Model Experience

无；此插件只排列已有对话视图，不贡献提示词、工具 schema 或 Session 事件。

#### KV Cache effect

无；插件不组装或发送模型请求。

## Known Limitations and Deferred Work

- 最多支持四个根 Session，暂不提供嵌套分割树或跨会话上下文共享。
- 目录只返回元数据，面板选中后才按需加载历史并启动项目运行时，不会预加载所有项目。
- 浏览器本地视图状态不跨设备或浏览器配置同步。
