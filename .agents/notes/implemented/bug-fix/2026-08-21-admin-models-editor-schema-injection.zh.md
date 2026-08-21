# Agent Note: Admin 组织模型编辑器必须使用共享设置依赖

Status: implemented

[English](2026-08-21-admin-models-editor-schema-injection.md) | 中文

## 问题

rc.1 设置编辑器升级后，Admin 模型治理页面的标题和组织模型数量仍然显示，但 Provider 与模型编辑器主体为空。组织数据和 PostgreSQL migration 都存在；Admin 专用适配器仍按升级前的单参数方式构造 `ModelsSettingsStore`，并且没有注入必需的 schema，因此共享 `ModelsSection` 按设计返回空内容。

## 决策

Admin 组织编辑器现在提供与浏览器设置插件相同的三个运行时依赖：schema 操作集合、设置 describe mirror，以及组织 REST wire facade。它把 schema 传给 `ModelsSection`，并用全部依赖构造 `ModelsSettingsStore`。由于这个界面在 workspace 客户端 bundle 之外复用共享设置实现，Admin Vite 构建显式映射 vendored Cordis、CosmoKit 和 Schemastery 源码。

组织 REST facade 继续作为组织 Provider profile、凭据和模型目录的事实来源。这个渲染缺陷不执行数据库 migration、数据回填或兼容性重写。

## 考虑过的替代方案

**执行或新增数据库 migration。** 否决：migration ledger 已经是版本 10，组织 Provider、模型、权限、价格和用量记录都存在。修改持久化数据不能修复缺失的 React 依赖。

**为 Admin 复制一套模型编辑器。** 否决：这样会复制必须与主设置界面对齐的 rc.1 schema 和能力字段行为。Admin 适配器应当提供共享编辑器所属的依赖，而不是复制编辑器。

**让 `ModelsSection` 静默接受缺失的 schema。** 否决：schema 回调负责模型能力、思考等级、多模态、校验和不可变路径编辑。隐藏缺失依赖会重新产生一个能够显示旧字段、却不能安全写入的编辑器。

## 后果

Admin 组织 Provider 及其模型行现在从已有的数据库 REST facade 渲染，包括共享表单暴露的 rc.1 思考等级和输入模态字段。修复只改变 Admin 客户端 bundle，不改变 PostgreSQL schema 或 wire 格式。浏览器要加载修正后的 bundle，需要新 release 和进程重启。

## 测试

Admin `ModelsPage` 回归套件的 3 个测试全部通过，覆盖共享完整 Provider/模型编辑器挂载、创建组织 Provider，以及权限/计价仍在治理视图中。生产构建通过 Harness/Web、两个插件、Gateway 类型检查、Admin Vite 构建和 artifact 校验。独立 release smoke 能从 `/healthz` 报告自身 release id；生产本地和公网 `/healthz` 均报告 `coharness-20260821-models-governance-fix`。
