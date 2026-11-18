# Agent Note: 上游工具层修复的选择性回移(rc.2..v0.2.2-rc.3)

Status: implemented

[English](2026-11-14-selective-upstream-tool-fixes.md) | 中文

## 问题

上游 `v0.2.2-rc.3` 线发布了十一条 `fix(tools)`/`fix(executor)` 提交。逐条对照本仓后发现三个我们同样存在的真实缺陷,其余则针对上游独有的机制:

- 持久 Bash 启动时执行 `stty -echo` 但未关闭 history expansion,含 `!` 的模型命令在执行前被交互式 shell 展开改写或丢弃(上游 `967ba4c`)。
- `ToolExecutionPipeline`/`dispatchToolBody` 把"调用方已 abort 后工具体抛出 signal 取消原因(或裸 `AbortError`)"归类为普通工具失败而非 `TOOL_ABORTED`(`fc6afa9`)。
- `update_goal` 会拒绝与所选 action 无关的已填充字段,`grep` 会拒绝恰好为空的 `include`——对模型合法产生的输入却报工具错误(`080a2c6`、`4e4badb`)。

## 决策

回移共享修复,其余记录为不适用:

- `tool-bash-persistent` 启动命令改为 `stty -echo; set +H`。
- `dispatchToolBody` 仅当未分类错误是 signal 自身的 `reason` 或名为 `AbortError` 时才映射为 `AbortError`/`TOOL_ABORTED`;`HarnessError` 身份与 abort 后抛出的普通域错误保持原分类。
- `update_goal` 的 schema 描述将不适用字段标记为忽略;`edit` 只转发 `objective`/`max_goal_rounds`,`blocked` 仍要求非空 `blocked_reason`,`presentCall` 只展示属于该 action 的字段。`grep` 将 `include: ''` 归一化为省略,纯空白值仍然非法;展示层去掉空过滤器后缀。
- 不适用:executor unload/settlement、locale 元数据、PTC 激活等提交位于我们尚未引入的 `tool-executor-*` 包;服务主体保留(`c0661b8`)与 executor 注册表通知(`e727a3b`)针对我们没有的 pipeline/`setExecutor` 架构;plan-mode 条件准入(`3ce7312`)依赖我们注册体系不存在的准入口,因此显式的 `agent`/`loggedActive` 检查仍是执行点;sandbox 描述改写跳过,因为我们共享的 `sandboxPermissionsDescription` 助手的语义是有意不同的。

## 已考虑的替代方案

**逐条 cherry-pick 上游提交。** 否决:tool executor 与 pipeline 文件结构不同,本就需要源码级适配。

**同时移除 resume-paused 禁止与 blocked 轮次阈值以对齐上游。** 否决:二者均为刻意保留的本地权限规则;上游的参数放宽不意味着放宽状态迁移。

## 影响

已启动工具体的取消现在一致报告 `TOOL_ABORTED`,交互式 Bash 接受 `!` 字面量,goal/grep 参数面对忽略字段不再报错。行为变化是增量放宽;除各自断言外无消费者依赖更严格的拒绝,相关断言已更新。

## 验证

`packages/core/tools` 新增三个回归用例,覆盖 abort 后抛出 reason、抛出 `AbortError`、抛出非取消错误三种情形;`tool-goal` 测试更新为忽略语义并按 action 覆盖 populated 字段;`tool-fs-search` 覆盖空 `include` 的解析与展示。三个 spec 全量通过(143、32、113 个测试)。
