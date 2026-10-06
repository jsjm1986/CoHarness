# Agent Note：Admin 插件页以统一插件实体列表取代「组成」与「安装」分栏

Status: implemented

[English](2026-10-03-admin-plugin-entity-list.md) | 中文

## 问题

Admin 插件页过去按实现层组织，而非按管理员心智中的对象组织。组成矩阵编辑 cordis 条目与 bundle 选择；下方的管理页又把同一批 bundle 与注册了配置页的官方插件并列成另一组卡片；同一个 bundle 可以在两个地方启用，却没有任何提示说明两个开关写入的是不同层。新手分不清「插件」到底在哪、哪个开关管什么，也看不出安装代码、加入组成、运行、配置是同一生命周期的四步。

## 决定

- [`composition.ts`](../../../../gateway/admin-ui/src/plugins/composition.ts) 把矩阵的数据层提取为 `usePluginComposition`：一个 hook 持有已保存的启动态、文件观察态、live 清单、合并行模型与绑定目标的启动草稿，以及 `save`/`discard`/`applyLive`/`refresh` 动作。页面上所有控件编辑同一份草稿，行内切换 bundle 与高级矩阵里的切换永不发散。
- [`PluginManagerPage.tsx`](../../../../gateway/admin-ui/src/plugins/PluginManagerPage.tsx) 渲染统一列表：每个已安装或可选 bundle、每个官方插件项各占一行，带类型徽标（功能包/功能）、状态徽标（已启用/未启用/可启用或 live 运行中/已停用）、启动位置与文件不一致时的将变更徽标、当前 live 开关、启动时草稿控件（bundle 复选框或条目三态选择器），以及原位展开的行内详情——原包页、官方项页与行级配置页不再独立成页。搜索框与状态过滤保持长列表可导航；包详情不再重复行上的 live 开关。
- [`PluginMatrix.tsx`](../../../../gateway/admin-ui/src/plugins/PluginMatrix.tsx) 变为共享组合的纯视图，折叠进「高级：组成视图」摘要，供需要条目级行模型的管理员与插件开发者使用。
- [`PluginsPage.tsx`](../../../../gateway/admin-ui/src/pages/PluginsPage.tsx) 在区块开头给出生命周期行（安装 → 启用 → 运行 → 配置），将草稿呈现为统计行内与矩阵全部待存差异的吸底保存/放弃条；实例停止时显示占位说明与仍可离线编辑的启动时控件。无状态存储的部署保持仅 live 控件，与矩阵既有降级一致。

## 已考虑的替代方案

**保留两个区块并互加交叉链接。** 重命名区块并从行链接到卡片只能解释分裂而不能消除；管理员仍要为同一对象编辑两个列表，草稿也仍归矩阵私有。

**彻底移除条目矩阵。** cordis 条目是 agent 侧 `plugin_manager` 工具与 `cordis.patch.yml` 共用的词汇；删掉表格后，没有友好卡片的受管行将无处呈现。矩阵折叠而非消失。

**任务流向导。** 「安装 → 启用 → 配置」向导适合首次使用，但失去批量管理能力；实体列表让每一面都可在行上触达，向导日后可作为入口叠加，而非替代。

## 影响

插件身份在「安装、启用、启动态、配置」各面收敛为每实体一行，条目级机制则距高级工作仅一层折叠。共享组合对象成为草稿与 live 写入的唯一通道，也是未来团队目录或权限界面的天然挂接点。覆盖：`components.spec.tsx` 锁定统一列表、过滤、将变更徽标与启动控件；`PluginMatrix.spec.tsx` 以页面形态 harness 驱动 hook；`PluginsPage.spec.tsx` 验证共享草稿条；`plugin-administration.e2e.ts` 在真实构建链路上重录了行 golden。
