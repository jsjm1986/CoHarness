# Agent Note: Process-stable tool scheduler symbol

Status: implemented

[English](2026-09-18-tool-scheduler-process-stable-symbol.md) | 中文

## Problem

源码启动的 Loader 组合在同一进程中加载了两份 `dsh-tools`。vendored Loader 通过 Node 内部模块加载器挂载配置条目，把 `@deepseek-ai/dsh-tools` 解析到构建产物 `lib`，而打包后的 `dsh-agent-loop` 产物内部的裸 `@deepseek-ai/dsh-tools` import 经 tsx `paths` 钩子解析到 `src`。两份副本各自声明自己的 `Symbol('@deepseek-ai/dsh-tools.scheduler')`，因此在 `lib` 运行时上 `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 取到 `undefined`，每次工具调用都以 `UNKNOWN: Cannot read properties of undefined (reading 'prepare')` 结束该 turn。

## Decision

`TOOL_RUNTIME_SCHEDULER` 改用 `Symbol.for`——即 subagent 内部符号与 `TYPERT_OWNED_VALUE` 已用于跨独立打包副本保持同一身份的进程级全局注册表。该槽位属于每个 `ToolRuntime` 实例自身，因此无论 `ctx.tools` 由哪份副本应答，其自带的 scheduler 都提供 `prepare`/`dispatch`/`finalize`/`finish`。

## Alternatives considered

**把 Loader 解析统一到单一平面。** 否决：让配置条目跟随 tsx `paths` 钩子需要对 vendored Loader 的模块加载动手术，上游以同样方式挂载条目，且影响面超出该缺陷本身。

**在消费方探测两个符号注册表。** 否决：让 `ctx.tools` 回退尝试第二个键会为一个槽位引入第二份事实来源；全局注册表正是为这种场景而存在。

## Consequences

工具调用在 source/artifact 混合组合下成功，单一平面的一致运行不受影响。`Symbol.for` 只覆盖这一个协议槽位——`instanceof` 检查与模块私有 `Symbol()` 键跨副本仍不同身，更深层的平面混载仍需各自修复。

## Testing

[product headless profile snapshot](../../../../examples/headless-agent/tests/headless.snapshot.ts) 在源码启动器下经真实 Loader 树驱动一次工具往返；改动前在 `prepare` 查找处失败，改动后通过。
