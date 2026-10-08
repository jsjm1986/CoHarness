# Agent Note: 进程型 Gateway 测试夹具的原子回环端口分配

Status: implemented

[English](2026-10-08-atomic-fixture-runtime-ports.md) | 中文

## Problem

`gateway/tests/instances.spec.ts` 与 `gateway/tests/apply-grants.spec.ts` 为每个夹具指定固定字面量 `HGW_INSTANCE_PORT_BASE`（43100–43420 与 43300）。分配器把 base 写入新 instance 行，spawn 出的 fake-dsh 子进程在 `127.0.0.1` 上绑定该端口。这些字面量全部落在 Linux ephemeral 端口范围（默认 `32768–60999`）内，因此同一 job 中任何内核分配的 loopback 端口——兄弟 Vitest worker 的 `listen(0)` relay、出站连接的源端口——都可能在子进程绑定时已占用该字面量。子进程随即以 `listen EADDRINUSE` 崩溃，并以远离原因的 readiness 失败形式上报；pull-request CI 在 `127.0.0.1:43410` 上命中的正是这一签名。

## Decision

夹具子进程改用 `listen(0)` 绑定，并把内核分配的端口发布到 `$DSH_HOME/child-port`；launcher 本来就按 runtime 身份注入 `DSH_HOME`，因此每个子进程都拥有私有的发布文件。每个 durable instance 端口——用户的 `instances` 行、project runtime 的 repository stub——都是 OS 分配的 [runtimeRelay](../../../../gateway/tests/runtime-relay.ts) 端口，它把每个接入的连接转发到子进程当前发布的监听器。`setup()` 包装 `users.create`，使每个新建身份领取自己的 relay 与端口文件；构造 stub repository 的测试则针对 project runtime home 领取 relay。字面量 base 仅保留为分配器输入，字面量端口断言改为对行端口或返回端口的关系断言。manager 从不 spawn 的 stub repository 保留字面量端口，因为这些值是数据而非绑定资源。

## Alternatives considered

- **先探测空闲字面量再让子进程绑定。** 探测与绑定之间隔着进程 spawn，其间一次内核分配即可重现同一类冲突。
- **按测试或文件划分互斥字面量区间。** 字面量仍在 ephemeral 范围内，内核可以把其中任何一个分配给无关 socket；区间划分也无法防御其他进程或 runner 流量。
- **串行化整个 Gateway 套件。** 文件级串行无法保护宿主机端口免受其他 spec 文件、独立 Vitest 进程或共享 runner 的 job 影响，还会为一个夹具的缺陷拖慢每次运行。
- **重试或延长 readiness 等待。** 子进程已经崩溃；延长等待只是更晚报告同一个崩溃，并不修复所有权。

## Testing

在运行前占用 `127.0.0.1:43410`，旧夹具可复现 CI 签名（`listen EADDRINUSE`，上报为 `instance for alice failed to become ready on port 43410`）；同一占用对新夹具无影响。两个独立的 `vitest run tests/instances.spec.ts` 进程并发执行且全部通过，`tests/apply-grants.spec.ts` 亦通过。`npm run typecheck --prefix gateway` 与 `npm run build:check --prefix gateway` 通过。

## Consequences

夹具子进程不再绑定固定端口，内核既不会把夹具的 durable 端口分配给其他 socket，也不会反向命中。relay 对过期发布也能确定性处理——针对已死子进程端口文件的连接会被销毁——清理顺序保持先子进程、再 relay、最后数据库与夹具根目录。[instance 端口分配器](../bug-fix/2026-08-28-reclaimable-instance-port-allocation.zh.md) 继续负责 durable 分配语义；本 note 只改变夹具实际绑定的端口。
