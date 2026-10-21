---
description: "调用技能、预览当前说明，并查看已记录的技能输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill

[English](README.md) | 中文

## 概述

从 Web 编辑器的 `/` 建议中选择 skill（技能），或输入 `/name` 即可调用。点击已发送消息中的技能引用，可以预览当前说明而不启动轮次。技能工具调用可展开为已记录的 `Instructions` 卡片；即使已安装的技能改变，卡片内容也保持稳定。源码预览与已记录结果分别帮助用户查看当前定义和较早调用所使用的说明。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[Web 应用 bundle](../../bundle/web-app/README.zh.md) 在其浏览器组合中包含此插件。本包没有专属配置字段。

选择 `/` 建议或直接输入技能名称。仅限用户调用的技能会在菜单中显示本地化标记。在命令位置，同名的 Host 命令优先。

<a id="current-skill-source"></a>
### 当前技能源码

点击已加载技能的消息中的技能引用，即可读取当前 Markdown 源码。预览使用该 Session 的运行时、工作目录和 preset；全局或其他提供方提供的技能无需具有工作区文件路径。预览不会展开参数、执行内嵌命令、启动轮次或改变历史。关闭或替换预览会取消读取。缺失或隐藏的技能显示不可用状态；读取失败时显示错误，重新打开预览即可重试。

<a id="skill-tool-row"></a>
### skill 工具行

展开已完成的 Skill 工具行，可在尺寸受限的 `Instructions` 卡片中读取完整的已记录输出。运行中的调用显示进度，失败调用以错误首行作摘要，中断调用显示警告。提供 `Inspect` 时，该操作会在轨迹中打开对应调用。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`/` source 通过 Session 的连接读取 `skill.list`。Host 选择其当前工作目录和 preset 作用域，不激活冷 Agent。目录按 Session 共享一次拉取；`warm` 在作用域打开时启动它，候选查询等待它完成，`agent-preset/selected` 使该 Session 的缓存失效，`connection/reset` 使全部 Session 的缓存失效。菜单调用方的取消不终止共享发现；失效与插件释放会将其终止。列表失败由 slash 壳层记录，并从该菜单移除技能分组。

source 插入字面文本 `/name `，没有裁决钩子或引用 codec。Host 的 [`dsh-tool-skill`](../../skill/tool-skill/README.zh.md) 识别提示词任意位置、以空白为界且允许用户调用的名称，并在模型步骤前注入 `<skill_content>`。因此 Web、TUI 和 ACP 使用相同的调用文本。lexicon 为草稿 token 添加视觉标记；`rankByName` 对不区分大小写的子序列匹配排序，前缀优先，同分保留 Host 顺序（[排名决策](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.zh.md)、[纯文本决策](../../../.agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.zh.md)）。

插件向 `conversation.chat.skill-preview` 提供当前源码对话框，向 `tool.call.toolview` 提供已记录结果的 renderer。对话框读取 `skill.get`；工具行的名称、状态和正文只来自持久化的调用／结果切片。两项注册都随插件 fiber 释放。`/client` 入口只导出插件主体；组件与 source 保持内部实现。

| 源码 | 职责 |
| --- | --- |
| [index.ts](src/client/index.ts) | Session 路由、目录生命周期和注册 |
| [SkillPreview.tsx](src/client/SkillPreview.tsx) | 可取消的源码对话框 |
| [SkillRow.tsx](src/client/SkillRow.tsx) | 已记录工具输出与轨迹导航 |

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Conversation](../ui-conversation/README.zh.md)——已发送消息与编辑器的归属。
- [技能注册表](../../skill/skill/README.zh.md)——提供方与调用控制。
- [Host API](../../host/apiproxy/README.zh.md)——经授权的技能读取。

<a id="model-experience"></a>
## 模型体验

### 用户显式 skill 调用

#### 模型看到的内容

用户消息原样到达模型，字面文本 `/name` 也包含在内。随后宿主的 pre-step 边界（`dsh-tool-skill`）把规范的 `<skill_content>` 块——与 `skill` 工具返回的 `renderSkillContent` 输出相同——作为注入的指令上下文追加在该步骤各项注入的末尾，最贴近模型的回答。加载是确定性的：模型无需被要求调用 `skill` 工具就能收到完整正文，目录也会告诉它不要重新加载已内联注入的 skill。

#### Token 影响

一次调用会把渲染后的 skill 正文作为注入上下文加进该轮次——成本与模型经由工具加载该 skill 相同，只是无条件支付，而非由模型自行裁量。浏览菜单、拉取候选和源码预览都不会增加模型 token。

#### KV Cache 影响

仅追加：注入的消息落在可复用历史前缀之后。该包绝不改写较早的请求 token。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

以下限制由可用的 Session 历史与寻址方式决定。

- **仅含工具结果的 history 页使用通用行**：键控分派要求配对的工具调用位于运行时窗口内；分页将工具调用留在窗口外时，工具结果没有工具身份。这项客户端呈现功能不会为了恢复该身份而扩展 history 协议约定。
- **技能引用是普通文本**：手动键入与菜单选择的 token 含义相同。技能 chip 不携带 occurrence 身份、位置跟踪或结构化引用载荷。
- **由目录寻址的子会话没有目录或当前源码预览**：这些读取要求已挂载的 Session，不得仅为显示历史而激活子会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
