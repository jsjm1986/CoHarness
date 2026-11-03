---
kind: upgrade-guide
description: "存储差异与请求乱序不会破坏审计结果筛选、总数和所选分页的一致性。"
---

# 保持审计筛选与所选分页一致

[English](guide.md) | 中文

## 变更

SQLite 结果筛选和计数遵循每行显示的结果。HTTP 状态优先于动作名；没有状态时，只有精确、区分大小写的失败后缀才将行判为失败。PostgreSQL 写入使用相同分类器。Admin 响应继续排除原始详情。

`GET /admin/api/audit` 的 `limit` 与 `offset` 必须是安全整数。小数或不安全数值会在访问数据库前返回400及 `error: invalid audit pagination`。受支持的整数仍会钳制：每页1至500条，负偏移量变为0。

审计页面只应用最新查询的结果、错误和完成状态。旧响应不能替换刚选的类别、筛选或分页，也不能隐藏其加载指示。 窄屏布局让审计类别控件在页面内换行，保留所有类别的可达性。

## 迁移

1. 按[现有流程](../../../../gateway/README.zh.md)部署 Gateway 并重新构建 Admin UI。这些修复无需新增数据库或 Session 格式迁移。
2. API 客户端及自定义审计服务提供整数分页计数，继续处理无效筛选的 HTTP400。分页总数与返回行使用相同的结果条件。
3. 验证以失败动作名记录的 HTTP 成功仍属于成功筛选、不带状态的失败事件仍可查询，以及旧查询无法替换较新的所选分页。[审计决策](../../../../.agents/notes/implemented/bug-fix/2026-10-10-audit-log-crash-and-faceted-query.zh.md)说明结果优先级和元数据限制。
