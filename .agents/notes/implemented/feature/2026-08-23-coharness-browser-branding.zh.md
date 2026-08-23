# Agent Note：CoHarness 浏览器品牌

Status: implemented

[English](2026-08-23-coharness-browser-branding.md) | 中文

## 问题

本地 Web 构建仍显示上游鱼形标记、`DSH Local Build` 标签和 DeepSeek Harness 安装元数据，尽管 CoHarness 是独立维护的产品。同一个回退标记还出现在空白会话 Hero 中，因此只替换侧边栏会让首次使用页面出现混合品牌。

## 决策

本地浏览器界面统一使用独立的 CoHarness 标记和名称：侧边栏与空白会话 Hero 的回退内容、文档标题、PWA manifest 以及构建生成的 favicon。现有 `sidebar.brand.*` 与 `conversation.hero.brand.mark` slot 保持不变，因此部署包仍可提供自己的占位者。official 构建 profile 通过 Web 构建选择保留的官方源文件，继续使用 DeepSeek Harness 标题、wordmark 占位者和 favicon。

该标记是一个带连接节点的开放弧线，由不依赖 Cordis 的 `CoHarnessMark` primitive 渲染，并使用 `currentColor` 跟随各宿主界面的主题。没有修改模型可见输入、会话事件、传输字段或内部软件包命名。

## 验证

专项 primitive、侧边栏、renderer 标题和 Web 产物测试覆盖新的标记、回退标签、标题投影、按 profile 区分的 manifest 与 favicon。构建 Web 产物测试同时接受 local 和 official profile，并检查对应的安装元数据。浏览器悬停回归测试仍通过稳定的宿主盒验证标记动画。

## 曾考虑的替代方案

**重命名内部 DSH 软件包和资源词汇**：不予采纳，因为兼容性工作仍依赖现有软件包名、slot 名称和 official profile 选择器。本次改动只限于浏览器可见的回退呈现与构建产物，内部运行时术语保持稳定。

**用专用的 CoHarness 品牌插件替换 slot 系统**：不予采纳，因为现有 slot 已提供所需的扩展点；本地回退还必须在没有挂载可选品牌包时正常工作。

**保留上游鱼形资源，只更换文字标签**：不予采纳，因为标记本身就是面向用户的品牌；继续使用它仍会让用户联想到上游产品。

## 后果

未显式选择 official profile 的生产构建现在会标识为 CoHarness，同时保留现有 `DSH_CLIENT_COMMIT_HASH` 诊断徽标。官方发布产物继续兼容上游品牌包和元数据预期。两个 favicon 源文件只是 Web 构建实现细节；公开 URL 仍是 `/favicon.svg`。
