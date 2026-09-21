# @deepseek-ai/dsh-skill-badge

[English](README.md) | 中文

可选的内置 skill（技能）提供方，向 `ctx.skills` 贡献 `dsh-badge`。该 skill 提供官方「powered by dsh」Markdown 片段和随包分发的 PNG，供无法可靠导入远程图片的系统使用。

挂载该插件即可启用提供方。它没有配置。随附的 CLI（命令行界面）组合以 `disabled: true` 包含该插件；用户必须显式启用其 `skill-badge` 配置行，该 skill 才会进入目录。

该提供方将随包分发的 `assets/` 目录作为 skill 资源基底公开。`dsh-badge.png` 是尺寸为 726×120 的源图资源，消费方以 121×20 的尺寸渲染。

## 概述

agent（智能体）可以通过该内置提供方加载官方「powered by dsh」徽章 skill，并遵循其指令，给文档、PR（Pull Request）以及其他用 DeepSeek Harness 生成的内容添加署名徽章。该提供方没有配置，随附 CLI（命令行界面）组合以禁用状态包含该插件，因此部署方需要显式启用。该 skill 同时提供 Markdown 片段和随包分发的 PNG，供无法可靠导入远程图片的系统使用。

## 不变量

**运行时不变量：** 未发布配套入口。该贡献是一项静态的打包 skill 注册，其释放由注册表的 HMR 安全性规格证明。

## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包会把该提供方的目录条目和所选 skill 的正文渲染给模型。

#### KV Cache 影响

该插件默认禁用，不会改变任何请求。启用后，其目录条目和任何已加载正文都会在各自插入点改变提供方的 KV 前缀。

## 已知限制与暂缓事项

- 该提供方只贡献一个固定 skill，不提供运行时自定义。
- 远程 Markdown 使用 Shields.io；当目标环境无法可靠获取远程图片时，请使用随包分发的 PNG。
