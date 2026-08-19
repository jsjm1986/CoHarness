# Agent Note: 上游 rc.8 与本地覆盖的同步

Status: implemented

[English](2026-08-19-upstream-rc8-overlay-sync.md) | 中文

## Problem

本地产品在上游 Harness 之上增加了 Gateway 治理、项目作用域工作区与文档、部署集成、Android 打包和协作界面。同步发布版本时，既要接纳上游 `dsh-v0.1.0-rc.8` 的包图与运行时更新，也不能静默丢失这些本地能力，或留下只注册了一半的浏览器界面。

## Decision

本地树把上游 rc.8 tag 作为一个 merge commit 的第二父节点，并把产品专属行为保留在所属包或 bundle overlay 中。Host/API 适配继续明确写在 Gateway 与附件 provider 中；浏览器能力只有在 Web bundle roster 列出对应包时才会加载；共享客户端 metrics 由动态主题插件在组件样式使用前挂载。跨平台浏览器审计把原生路径打开 stub 为成功的 Host 响应；seeded-history 套件继续覆盖真实拒绝对话框与重试行为。

同步保留本地首次启动、协作、文档、项目、部署和 Android 决策，同时采用 rc.8 的 session、provider、多模态、settings、持久化和包布局更新。包清单与 Cordis 配置仍是运行时闭包的权威来源；不为 rc.8 之前的磁盘格式引入兼容 shim。

## Alternatives considered

**用 tag 直接替换本地树。** 拒绝，因为这会移除仍属于部署组合的产品能力。

**保留没有 merge parent 的长期兼容 fork。** 拒绝，因为它会隐藏上游血缘，增加后续版本比较与冲突归属的成本。

**让浏览器测试依赖主机的原生打开器。** 拒绝，因为不同操作系统的打开器可用性不同；浏览器审计关注界面几何，拒绝路径由专门的确定性测试覆盖。

## Consequences

合并历史记录了精确的上游 rc.8 parent，本地所有权仍可在包级代码与 bundle patch 中直接看到。缺失浏览器 roster 行或全局客户端样式会由定向 Web E2E 与样式契约测试暴露。Android 编译仍要求 Java Runtime；诊断会报告该环境前置条件，而不会把它误判为源码回归。
