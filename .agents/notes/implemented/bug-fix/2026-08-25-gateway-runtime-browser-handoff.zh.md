# Agent Note: Gateway-managed runtimes suppress browser handoff

Status: implemented

[English](2026-08-25-gateway-runtime-browser-handoff.md) | 中文

## Problem

用户切换账户作用域或在文档管理器中浏览其他作用域时，Gateway 会启动独立的 `dsh web` 进程。Web 组合在普通 `dsh web` 启动完成后会打开默认浏览器，因此后台运行时启动可能在操作员机器上打开 `http://127.0.0.1:<runtime-port>`，并把内部端口暴露到浏览器界面。

## Decision

Gateway 生成的源码和 release 运行时命令都会传入 `--no-open`。如果自定义 `HGW_DSH_COMMAND` 没有携带同一参数，Gateway 会在加载配置时拒绝启动。Gateway 配置参考把该参数标记为后台运行时的必需属性。公开文档列表仍受独立的[Gateway 持有文档作用域列表](2026-08-25-gateway-document-scope-loopback-leak.zh.md)决策保护。

## Alternatives considered

**在 Web 组合内部通过环境变量推断 Gateway 归属。** 不采用，因为这会让通用 Web 应用依赖 Gateway 专属的进程标记，并增加跨包配置约定。

**允许自定义命令自行决定是否打开浏览器。** 不采用，因为缺少参数会在部署变更时静默恢复问题行为；配置必须在任何运行时启动前失败。

**全局关闭 `dsh web` 的浏览器打开行为。** 不采用，因为交互式本机 `dsh web` 启动仍应保留既有浏览器交接。

## Consequences

作用域切换和文档其他作用域读取可以启动运行时，同时不会创建浏览器标签页或离开公网 Gateway。使用自定义运行时 wrapper 的部署必须把 `--no-open` 传递到 Web CLI；错误命令会在 Gateway 启动时报告，而不会延迟到 UI 侧产生副作用。

## Testing

Gateway 配置测试覆盖源码和 release 默认值、自定义命令拒绝以及带参数的可接受命令。Launcher 与 systemd 单元测试固定生成的执行命令包含 `--no-open`。
