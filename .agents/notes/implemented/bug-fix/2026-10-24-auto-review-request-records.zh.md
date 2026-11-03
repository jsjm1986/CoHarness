# Agent Note: Durable Auto review request inputs

Status: implemented

[English](2026-10-24-auto-review-request-records.md) | 中文

## Problem

Auto review 将策略、工作目录、保留的指令和绑定时的工具描述发送给模型。Session 记录待执行调用及拒绝结果，却遗漏完整的已解析 reviewer 输入。

## Decision

每次 reviewer 准备一个 LLM 调用，冻结已解析配置和完整输入，在发送前追加必须理解的日志事件 `auto-review/request`，并记录待执行调用 id。派发保留已准备的适配器，携带 Session 和既有已验证账务见证，显式请求 execution 准入。发布前取消不会产生请求；准备、持久化或准入失败沿用既有审查失败结果，不执行工具。

该事件不进入主对话，包含策略、已解析工作目录、保留历史和待执行的原生或 PTC 动作文本。风险、reviewer reasoning 和原始响应仍不记录；既有结构化拒绝保留可选理由。此决策仅替代 [Auto 功能决策](../feature/2026-08-28-auto-review.zh.md)中省略请求和临时 schema 不保留的规则。

## Alternatives considered

**从当前代码与注册表重建。** 策略、配置、工作目录和 binding 都可能在发送后改变，当前值无法证明之前的输入。

**把 reviewer 输入追加到主对话。** 主模型不消费这些输入；独立日志事件保留输入，同时保持主 surface 的内容。

## Consequences

重复保留的历史增加 Session 存储量。格式版本仍为 7；不认识该必需事件的构建会拒绝受影响日志。已提交代次继续保留，不做转换，也不提供降级支持。开始和结算事件保持既有字段。

## Verification

负向对照证明原请求前没有记录，也没有显式准入意图。真实 LLM 单元用例比较完整记录与派发输入，并确认许可释放。SDK 验收运行正式 reviewer 和工具执行器，写入自有文件，投影请求和已完成许可，再用新运行时恢复持久 Session。源码、构建模式与 Python 夹具共享确定性模型和受控准入提供者，不证明付费提供方行为。
