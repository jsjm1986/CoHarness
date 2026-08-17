# Agent Note: Web Chat 在气泡上标出项目发送者

Status: implemented

[English](2026-08-17-web-chat-sender-attribution.md) | 中文

## 问题

共享项目对话会把已认证参与者元数据存在每条获准的 `user/message` 上，但 Web Chat 气泡仍把该消息渲染成匿名的右对齐提示。读者若不展开配对的 `collaboration-context` 提示，就无法看出是谁发的；而该提示是面向模型的 JSON 元数据，不是对话行。

## 决策

Chat 从普通 `user/message` 的 `source.participant` 为持久用户气泡和 steering 气泡标注发送者。显示名优先；空白显示名回退到用户名；缺失或不可读的参与者不加标签。组织管理员附加本地化的 `participant.admin` 后缀。对齐保持靠右。待处理 steering 在准入前没有参与者，因此不加标签。

`collaboration-context` 提示仍留在会话日志和模型请求中。Chat Message Definition 仍然匹配它，以免 unknown-surface fallback 认领它，然后 `buildViewNode` 返回 null，因此该提示不会出现在 transcript 中。

解析留在 `ui-conversation` 本地。Chat 插件不导入 `dsh-collaboration-context`。

## 备选方案

**把提示渲染成上下文行。** 否决：该提示是模型元数据，不是人类消息；气泡已经标出名字后，再显示提示只会重复。

**导入 `dsh-collaboration-context` 的解析器。** 否决：该包会校验完整项目快照，并在数据畸形时抛错。Chat 只需要从恢复或外部日志里读出显示名，且不能让 transcript 失败。

**把其他人靠左，或给自己显示自称。** 否决：需求是便于阅读的归属，不是即时通讯式的身份分栏。当前账户不是 Chat-node 字段；对照实时 Gateway 上下文会把历史气泡绑到会话身份上，而后续账户编辑不得改写这些历史。

**把名字放进气泡内部。** 否决：这会把界面装饰混进消息正文，并改变复制内容。

## 后果

个人对话不加标签。账户改名不会更新历史名字。旧客户端留下的提示仍占用日志空间和模型 token。ACP 与 CLI transcript 不变。

## 测试

`ui-conversation` 单元覆盖钉住名字回退、管理员后缀、不加标签的个人来源，以及 Chat 省略该提示且不把它提升为 unknown-surface。jsdom Chat 覆盖钉住用户气泡和 steering 气泡。一份无密钥组装 Web golden 播种两位带归属的发言者和一条提示，并断言名字出现而提示正文不出现。
