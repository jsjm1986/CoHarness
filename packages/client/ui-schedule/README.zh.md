---
description: "Session 会话头部活动 Schedule 提醒的只读 Web 目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-schedule

[English](README.md) | 中文

## 概述

这是一个可选的浏览器插件，在会话头部渲染当前 Session 的活动 Schedule 提醒。它读取完整的 `schedule` projection，不发 RPC，也不执行 mutation。浏览器派生排序、本地时间、状态与相对时间；这些呈现值不会进入持久状态。

默认 Web 组合会解析本包但保持 Loader row 禁用；`examples/web-schedule/cordis.yml` 与 Host Schedule 插件一起启用该 row。只有 Session 成功打开且至少有一条活动提醒时，触发器才会出现。

每行保留完整 prompt，显示「等待中」或「已逾期」，重复间隔使用最大可整除单位，并在挂到 body 的弹层中换行显示元数据。Escape 与外部指针按下会关闭目录；通过 Escape 关闭时焦点返回触发器。live 更新移除最后一条记录时，组件会先关闭弹层再卸载。

## 实现

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 注册 locale 并贡献会话头部 slot |
| [`src/client/ScheduleCatalogAction.tsx`](src/client/ScheduleCatalogAction.tsx) | 可见性、排序、格式化、弹层与键盘行为 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文目录文案 |
| [`src/index.ts`](src/index.ts) | 可选浏览器插件的空 Host 入口 |

组件通过 `useSession` 与 `useProjection('schedule')` 读取数据，不直接检查 Host 服务。定位复用共享的 `useAnchoredPosition` 与 `useDismissOnOutsidePointer` 原语，包含 portal 弹层的 ref。

## 模型体验

### 活动 Schedule projection

#### What the model sees

无。本浏览器包为人类头部目录读取已完成的 `schedule` projection；它不改变 prompt、消息、schema、流或工具结果。

#### Token effect

无；本包从不组装或发送 provider 请求。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## 已知限制与延后工作

- 目录只读；Schedule 创建与取消仍由模型／工具操作负责。
- 本地时间与相对时间跟随查看方浏览器的 locale、时区与时钟。
- 只显示活动记录；交付历史仍保存在 transcript 中。
