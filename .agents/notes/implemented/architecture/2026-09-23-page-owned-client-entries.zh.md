# Agent Note：页面级客户端条目生命周期

Status: implemented

[English](2026-09-23-page-owned-client-entries.md) | 中文

## 问题

启动和热更新代码分别创建、替换同一批浏览器 Loader 条目。启动后忽略图快照，会让 Host 清单变化后的已打开页面缺少插件，或保留已经删除的条目。保留这两条路径也使上游启动批次及其真实浏览器验证未被采用。

## 决策

在 [client/modules](../../../../packages/client/modules/README.zh.md) 中采用 alpha.2 的 `WebBootGraph.batches` 与 `ClientEntries`。Host 构建带版本标识的不可变 bootstrap 和 application 资源。一个页面控制器创建初始条目、协调后续图、重试失败并替换重建代码。代次检查拒绝陈旧下载；替换时先等待旧 fiber 和所属样式清理，再激活后继。

[Web 内核](../../../../packages/client/web/README.zh.md)保留 CoHarness 平台种子、runtime 预加载、AbortSignal 兼容和鉴权组装。在 Cordis 之前创建模块系统，不意味着需要第二个条目所有者：`bootClient` 将真实 Loader 交给同一控制器。其状态是带显式结构类型的裸可观察值，避免仅为类型声明就让 bootstrap 机制依赖 Workbench runtime。

[Client HMR](../../../../packages/client/hmr/README.zh.md)将经过校验的传输帧交给控制器。[插件清单](../../../../packages/client/ui-settings-plugin-inventory/README.zh.md)通过框架绑定的 hook 读取状态，且只重试当前页面。Host 启用状态、账号和项目权限、其他浏览器页面保持独立。本地预设分组与搜索保持原位。

生产环境保持图传输启用，产物轮询遵循[显式开发配置](2026-08-23-production-client-hmr-opt-in.zh.md)。这既保留实时成员变化，也不增加周期性文件系统工作。

HTTP 载体支持经过转义的建议性脚本预加载。现有末尾就绪脚本仍负责确认就绪；预加载不代表脚本已经执行或成功激活。

## 考虑过的替代方案

**保留独立的启动与 HMR 所有者。** 两者都需要同样的清单、替换、重试和清理规则，会增加漂移，并允许陈旧下载重新激活已删除条目。

**为采用模块加载器而替换 Workbench。** 布局与 Session 归属独立于模块到达和 Loader 条目生命周期。承接这项上游行为不需要替换它们。

## 结果

上游条目和传输测试运行在已采用的实现上。本地外壳和清单测试保护保留的适配层；真实浏览器场景验证清单变化、重试、多页面与默认产品隔离。这些检查证明启动和模块生命周期行为，不代表 Session 引用、右侧栏或发布验收已经完成。
