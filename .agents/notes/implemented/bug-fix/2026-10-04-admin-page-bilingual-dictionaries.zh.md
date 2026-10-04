# Agent Note: 全部管理页面双语词典

Status: implemented

[English](2026-10-04-admin-page-bilingual-dictionaries.md) | 中文

## 问题

`adminLanguage()` 语言缝与插件词典之外，其余管理页面全部渲染硬编码中文：约一千条字面量分布在十三个页面及其共享件上（详情/用量/归档/文档/桌面/审计/用户/模型/SSH/终端/部署/Webhook，以及 `users.tsx`、`usage.tsx`、`ResourcePermissions`、`UserQualificationCard`、`ProjectDirectoryBrowser`、`NodeConfigurationSection` 和四个 `*Permissions` 包装件）。英文偏好下得到的是英文外壳包着全中文正文。

## 决策

每个面一个词典文件——`*.copy.ts` 与所属页面或组件同目录——沿用 `chrome.copy.ts` 形态：`zh` 为键源（`keyof typeof zh` 导出键类型），`en` 满足 `Record<Key, string>`，键位对齐是编译期性质。组件内 `t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])`；模块帮助函数在使用点解析 `translateCopy(adminLanguage(), …)`，与切换即重载的契约一致。按报文枚举键控的字面量标签映射改为类型化 `Record<Discriminant, CopyKey>`，使封闭联合穷尽性在提取后依然成立；`dateLocale` 键把 `zh-CN`/`en-US` 带入 `Intl.DateTimeFormat`。服务端提供的字符串按设计保持中文：`node-config-fields.ts` 的 `label`/`help`/`unit` 经报文下发，不改报文无法跟随客户端偏好——这是产品边界而非欠债。语言选择器的 `中文` 选项在两种模式下都以自身语言命名。

## 文件

- 新词典：`pages/{project-detail,webhooks,deployment,users,user-detail,models-page,ssh,terminals,archives,usage-page,audit,project-list,documents,desktops,node-configuration}.copy.ts`、`components/{models,resource-permissions,usage,archive-conversation,users,project-directory-browser,user-qualification-card,permissions}.copy.ts`，合计约 1,100 个键。
- 消费方：对应 `.tsx` 文件各自接入 `translateCopy(adminLanguage(), …)`；组件 API 无变化。

## 考虑过的替代方案

**整个 admin 共用一份巨型词典。** 键与消费它的页面或组件就近放置；上千键集中在一份文件会跨越每个页面边界，每次页面修改都会在这里制造合并冲突。

**连同 wire 下发的标签一起翻译。** `node-config-fields.ts` 的 `label`/`help`/`unit` 与服务端错误文本经 wire 下发，不携带逐请求偏好；对它们键化需要协议层改动，因此作为产品边界保持中文，而非客户端欠债。

**在渲染调用点临时构造 `t`。** `translateCopy` 是纯工厂；每个组件用 `useMemo` 绑定一次翻译位让 parity 成本为零，并符合切换后重载生效的契约，而不是每次渲染重建。

## 影响

`coharness-admin-language` 为 `en` 时全部管理页面与共享件渲染英文；默认仍为中文，全部 zh 断言原样通过。新管理文案必须以 `zh` 键加 `en` 词条进入词典——内联字面量会重新破坏键位对齐。经报文下发的文案（节点配置字段标签、Webhook API 错误消息、审计元数据值）刻意不在范围内，保持服务端语言。
