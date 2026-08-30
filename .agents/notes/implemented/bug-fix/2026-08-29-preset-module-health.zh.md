# Agent Note: 在发现阶段检测无法解析的 preset 模块

Status: implemented

[English](2026-08-29-preset-module-health.md) | 中文

## 问题

包被移除或相对插件文件消失后，preset 组装仍可能语法有效。把失败推迟到会话创建，会让名单继续提供无法启动的 preset，也不会给用户逐行诊断。

## 决策

发现阶段对启用行执行无副作用的解析检查。包名通过已安装 harness 的向上 node_modules 搜索检查；相对文件从 preset 目录解析；绝对路径和 file URL 直接检查；加载器 builtin 与 truthy-disabled 行无需查找。检查会遍历嵌套 group 并报告所有无法解析的行。当 roster context 提供 `baseUrl` 时启用；调用方省略它时，导出的扫描 helper 保留仅检查形状的行为。插件执行和服务就绪失败仍由挂载阶段负责。

## 备选方案

**在发现时 import 每一行。** 不予采用：发现过程不能执行插件代码或触发副作用。

**把所有名称都相对 preset 目录解析。** 不予采用：用户 home 下的 preset 无法访问 harness 安装的包依赖。

**只报告第一个缺失行。** 不予采用：逐行修复会让损坏组装变成不必要的迭代。

## 影响

preset 选择器可以在会话启动前识别过期的包和文件引用，而插件 apply 抛错与缺失注入服务仍保留挂载时诊断。包含根目录的 roster 必须由 Loader 提供 `ctx.baseUrl`，解析基准因此明确。新会话 preset 席位在选择拒绝包含结构化 `details.reason` 时优先使用该原因，因此 UI 只显示一次可操作的根因，不重复 preset 包装信息。

## 测试

发现测试覆盖包、相对、绝对／builtin、disabled、悬空链接、嵌套 group 和多行诊断；席位测试覆盖结构化拒绝原因；完整 preset 挂载与 authoring 套件继续覆盖既有生命周期检查。
