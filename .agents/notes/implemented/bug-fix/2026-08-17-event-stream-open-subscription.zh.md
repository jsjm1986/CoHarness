# Agent Note: 事件流在开启时订阅

Status: implemented

[English](2026-08-17-event-stream-open-subscription.md) | 中文

## 问题

API Proxy 原本会在调用 `events.mux` 和 `events.host` 方法时安装监听器。协作 ACL 集成把异步可见性初始化移入 async generator 主体，而 async generator 在首次拉取前不会执行，因此连接获准并调用流开启方法后，只要稍后才开始消费，这段间隔内提交的 Session 或 Host 增量就会全部丢失。mux 视图测试在首次迭代前创建、追加并销毁 Session 时暴露了同一时序错误。

## 决策

两个事件流方法继续返回单消费方 async generator，但 API Proxy 会先通过内部 `openStream` 适配器启动 generator，再把它返回。适配器为之后的消费方保留首个待定结果，并把 `next`、`return` 和 `throw` 委托给同一个 generator。监听器注册和协作初始化因此从方法调用时开始，与载体的流开启生命周期一致，而帧投递仍由拉取驱动。

两种流实现共用同一个适配器。ACL 过滤、初始化队列、principal 过期、中止处理和清理仍由现有 generator 负责；适配器只改变这些工作开始的时点。调用方 return iterator 时仍会进入 generator 的清理路径。

该时序规则扩展了[项目协作对话](../feature/2026-08-15-project-collaborative-conversations.zh.md)决策：授权可以延迟发布，但不能在 Host 已接纳流之后产生一段无人观察的间隔。

## 验证

API Proxy 测试覆盖 mux 流在 Session 创建并销毁前已经开启，以及 Host 流在首次拉取前接收已经提交的 Session 新增。协作测试继续覆盖初始 ACL 批次待定期间提交的增量，以及 principal 过期时关闭流。

## 曾考虑的替代方案

**要求每个调用方在执行其他工作前先拉取。** 否决，因为公开的开启方法已经代表流获准，载体调度不应成为事件投递正确性的组成部分。

**把所有监听器与快照操作移到 generator 外部。** 否决，因为这会在两种流之间重复初始化和错误处理。启动现有 generator 能保留单一生命周期所有者和既有清理路径。

## 后果

调用 `events.mux` 或 `events.host` 会立即开始订阅和授权工作。消费方可以推迟首次拉取而不丢失后续增量，两种流继续保留既有 wire 帧、ACL 决策、背压、过期和销毁行为。
