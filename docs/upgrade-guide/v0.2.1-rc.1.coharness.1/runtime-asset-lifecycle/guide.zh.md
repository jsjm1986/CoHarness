---
kind: upgrade-guide
description: "Runtime 资源请求不再启动或替换不可用的 Runtime。"
---
# Runtime 资源要求进程已经就绪

[English](guide.md) | 中文

## 变更

浏览器对 `/assets/*`、`/favicon.svg`、插件 JavaScript、CSS 或源码映射的 GET/HEAD 请求不再触发 Runtime 启动或代次替换。进程不可用或活动租约失效时返回503；手动停止的 Runtime 仍返回409。严格限定的带修订资源使用只读代次引用，不写执行活跃时间，接收 Runtime 要求绑定精确方法／URL 的 `runtime-asset` 断言。当前登录、权限、节点租约和撤权检查继续生效。未版本化资源和动态请求保留普通准入。

## 迁移

1. 使用同一发布版本部署 Gateway 和 `@deepseek-ai/dsh-gateway-runtime`。在管理员确认安全停止点前，保留不兼容进程及其发布文件；显式重启它们，不通过重试资源请求执行升级。
2. 重试失败的资源加载前，先打开所选工作台，或使用其经过认证的“启动并打开”操作。自定义客户端不能将资源请求用作启动探测。
3. 确认就绪代次的带修订 GET/HEAD 成功且不修改 `harness.instances.last_activity_at`，手动停止的 Runtime 返回409且不改变代次与进程状态。普通工作台入口保留现有启动行为。不需要配置或数据迁移。
