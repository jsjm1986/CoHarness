# Agent Note: 构建期插件表面与命令测量门禁

Status: implemented

[English](2026-08-23-plugin-surface-and-performance-gates.md) | 中文

## Problem

仓库用“一切都是插件”描述可替换的运行时能力，但启动代码、静态浏览器库、协议包和平台载体有意位于 Loader 树之外。此前没有一个确定性的门禁报告这份区别，性能测量也容易与正确性测试混在一起，或拿不同构建产物进行比较。

## Decision

`verify-plugin-surfaces` 从所有工作区包 manifest、树外插件 manifest、客户端构建 preset、Bundle patch 文件和 Web 组合中推导稳定的构建期分层。它验证动态与静态客户端声明，包括位于 `packages/client` 之外的浏览器面、工作区和树外 Bundle patch 目标、允许的 immediate 预取列表以及生产客户端 HMR 开关。它只输出计数和违规，不向运行时增加元数据。`perf:command` 直接启动外部命令，使用显式预热次数、记录次数、排序样本、中位数和 nearest-rank P95；它不插入产品代码，也不通过 shell 调用。

架构与开发参考文档会指向这两个命令。客户端包门禁会对每个动态客户端声明执行浏览器模式和依赖检查，包括位于 `packages/client` 之外的 API、registry 和 extension 包。`verify-cordis-config` 还会把树外 Bundle patch 中的裸插件行解析到 Bundle 声明的 dependencies 或 peers。性能测量与正确性测试保持分离，输出携带命令、Node 版本、平台和架构，因此基线不会静默混用不同产物。

## Alternatives considered

**给每个包增加运行时 tier 字段。** 否决：分层是构建和组合事实，把它带入进程只会增加元数据，不会改善运行时行为。

**把耗时断言放进普通单元测试。** 否决：宿主调度和文件系统差异会使正确性测试不稳定；独立测量可以使用重复样本和显式基线。

**只按目录名分类包。** 否决：双面包、静态客户端 preset 和 Bundle 声明会跨越目录边界；验证器读取实际控制加载的 manifest 与构建配置。

## Consequences

运行时继续使用现有插件和模块路径，同时 CI 获得确定性的表面报告和可复用的命令测量入口。新增 immediate 浏览器行或修改 Bundle 声明时，表面门禁会要求组合变化可解释。测量结果是证据，不是固定延迟承诺；在性能 lane 变成阻断门禁前，仍需评审基线并单独确定预算。

同一改动也保持客户端分层真实，同时不增加热路径开销。类型专用投影会被擦除，因此不会创建浏览器模块请求；领域门禁允许这类引用，但仍拒绝活跃的兄弟领域导入。运行时 scope、通知、队列、图像装饰和会话投影工具现在位于共享客户端文件中，组装后的 UI 只保留一份实现成本，并继续通过所属插件保持可替换性。
