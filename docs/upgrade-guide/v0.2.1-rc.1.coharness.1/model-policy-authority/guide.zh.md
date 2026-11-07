---
kind: upgrade-guide
description: "模型策略解析当前账号权限，即使目录版本未变，也会刷新有效授权。"
---

# 在账号变更后刷新模型策略

[English](guide.md) | 中文

## 变更

模型策略在准入后读取当前账号及成员权限，不再信任缓存的请求角色。资格撤销时拒绝投影。主动与惰性刷新同时比较有效内容及目录版本，因此账号角色变化无需修改模型，也能传达到运行中的消费者。

凭据存储和文件读取错误会传播，不会轮换 intake Bearer 或替换策略。无效 JSON 仍可恢复。刷新跳过停用账号；Admin 查看时显示无有效访问权，并保留覆盖项。角色与停用组合变更会停止 Runtime，不再尝试重启。

## 迁移

1. 按[现有流程](../../../../gateway/README.zh.md)部署 Gateway，无需数据库或 Session 格式迁移，也不新增策略 JSON 字段。
2. 自定义 `GatewayModelGovernanceService.policyFor` 实现解析当前符合条件的账号及成员角色。停用账号查看需要实现 `configurationRevision`；缺失时返回503。
3. 保留逐请求的执行、凭据与额度检查。投影文件不是持续持有的授权租约。
4. 验证提权和降权无需改变模型版本即可刷新权限、实际模型调用观察到撤权、查询故障保留现有策略及 intake 凭据，以及角色与停用组合更新只停止、不启动替代进程。参见[权限决策](../../../../.agents/notes/implemented/bug-fix/2026-10-29-model-policy-authority.zh.md)。
