# Agent Note: The Plugins page add menu carries the Creator entry

Status: implemented

[English](2026-10-15-plugins-page-creator-entry.md) | 中文

## Problem

对话式插件创作流程——暂存 `cordis` 预设、打开空白会话、等用户发送需求后才执行——此前只能从 Agent 预设设置区块进入。上游 alpha.2 把同一份草稿暴露在 Plugins 页的添加控件上，那才是想要扩展产品的用户实际停留的位置。本地页面单一的安装按钮没有承载贡献动作的开口，而第二个入口绝不能再造一份草稿：两套「暂存 `cordis` 并开会话」的实现，恰恰会在保证安全性的语义上漂移。

## Decision

`ui-plugin-manager` 把 **Add plugin** 改为分裂控件：主按钮仍打开安装对话框，相邻的箭头展开一个菜单——先是同一个安装动作，随后是 `plugins.add.actions` 槽位，即页面在其 `main` 注册上声明的 root 级列表。贡献项收到 `onDismiss`，入口可以先收起菜单再跳转。

`ui-agent-preset` 向该槽位贡献 `CreatePluginMenuItem`(id `create-plugin`)，绑定到设置区块按钮调用的同一个 `creatorDraft` 闭包——一条暂存路径，而不是两条。菜单项在挂载时加载预设名单，对每一种未就绪状态（加载中、不可用、错误、缺 `cordis`）渲染带说明的禁用行；仅当名单返回 ready 时才可用，而 ready 已蕴含 `modeSelectionEnabled`。选中后先收起菜单，再以 introduce 提示暂存 `cordis` 并发起新会话——草稿语义不变：用户输入需求之前不发送任何内容。

启动门禁读取两个界面的证据：section store 的 `showPicker` 或共享名单的 ready 状态。用户从未打开过的入口，不能否决另一个入口已经证实可行的启动。

## Alternatives considered

**在 `ui-plugin-manager` 内硬编码 Creator 项。** Plugins 页将不得不引入 agent-preset 的概念——名单状态、`cordis` id、seat 暂存——颠倒槽位系统存在的分层意义。页面拥有菜单外观；预设插件拥有这个入口。

**为菜单单独做一条草稿路径。** 否决：暂存后等待的语义和 introduce 提示属于同一条代码路径；为了让 store 分离而复制它们，恰好会重新制造共享闭包所防止的漂移。

**自动发送一条起始需求。** 草稿的意义在于需求由用户本人撰写；自动发送会把一个菜单项变成一次静默的 agent 运行。

## Consequences

`ui-agent-preset` 对 `dsh-client-ui-plugin-manager` 新增一条仅类型依赖，用于 `plugins.add.actions` 的 SlotMap 合并——peer 加 dev，无运行时 import。Creator 入口现在可从两个界面进入且启动语义完全一致；隐藏模式选择的部署会看到菜单项带原因禁用，而不是消失。入口随绑定 `creatorDraft` 的会话作用域销毁，因此 face 读取的是当前绑定而非捕获值。

## Testing

`create-plugin-menu-item.client.spec.tsx` 覆盖可用渲染、先收菜单再启动的次序、键盘选择，以及加载中/错误/不可用/缺预设的禁用状态。`apply.client.spec.ts` 走真实组合:`main` 页面声明 `plugins.add.actions`，贡献注册为 id `create-plugin` 的 `CreatePluginMenuItem`，且在从未加载设置区块的情况下调用其注入 face 即可发起一个 Creator 会话。
