# Agent Note: 官方 rc.7 插件兼容基线

Status: implemented

[English](2026-08-18-official-plugin-compatibility-baseline.md) | 中文

## Problem

上游 rc.7 插件词汇使用 `cordis/*` 事件名称，而这个 fork 的重命名 Cordis 运行时使用 `@deepseek-ai/cordis/*`。Remote 订阅如果只按精确名称匹配，就会让其中一套词汇能够到达 Client，同时静默排除另一套。Loader 已经接受 rc.7 插件入口形态，但在上游再次变化之前，需要用真实组合测试钉住这项支持，并明确兼容范围。

## Decision

兼容基线覆盖已观察到的 rc.7 插件和事件格式，同时不改变 fork 当前的运行时词汇。它是[命名约定](2026-08-11-repository-naming-contract-and-rename-ledger.md)中「仓库自有名称使用单一词汇」规则的一项窄例外，并且只在外部 Cordis 事件边界扩展 [Remote 事件投递](2026-08-10-remote-event-delivery.md)机制。

- Host 和 Remote 名单为六条动态 Cordis 事件声明两个前缀。Host 继续只发出已有的 `@deepseek-ai/cordis/*` 名称，因此一条 Host 通知只产生一个帧。
- Client Remote dispatcher 只将明确列出的六组 `cordis/name` 与 `@deepseek-ai/cordis/name` 视为同一组名称，按全局注册顺序合并匹配的订阅；同一个 listener 同时以两个别名注册时每帧只调用一次；同一精确名称的重复注册仍保留。其他 Cordis 名称继续精确匹配。listener 失败继续隔离。
- 真实 `boot()` 组合覆盖命名导出的 ESM 函数插件、默认导出的 class 插件、CommonJS 对象插件、注入服务和 Standard Schema 配置规范化。默认导出与命名函数插件元数据混用不属于支持目标，因为 Loader 的导出展开逻辑有意保持这条边界明确。
- 这是 rc.7 兼容基线，不是对未来上游破坏性更新的自动承诺。后续上游格式需要新的兼容决策和覆盖测试。

## Verification

API Proxy 测试 emit 官方 Cordis 名称，并在 Host 流中观察完全相同的名称和载荷。Gateway Client 测试覆盖两个派发方向、合并后的顺序、别名去重、同名重复注册、不折叠未列出的未来 Cordis 事件组、listener 异常隔离和未知事件丢弃。app-boot 组合测试通过临时 `cordis.yml` 真实启动三种入口形态，并观察注入后的规范化状态。

## Alternatives considered

**Host 同时发出两个事件名称。**不予采纳，因为这会产生重复 wire 帧；同时订阅两个名称的消费方还会收到重复副作用。别名应当归属于 Client 订阅边界。

**让 Loader 推断 default 与命名导出的混合形式。**不予采纳，因为官方约定是明确的：函数插件使用命名导出，Service/class 插件使用默认导出。推断混合形式会隐藏错误的包边界。

**自动跟随上游变化。**不予采纳，因为未来破坏性更新可能改变载荷、生命周期语义或导出约定。兼容性保持为明确且有测试的基线。

## Consequences

官方 rc.7 插件可以通过现有 Remote 路径使用 canonical Cordis 事件名称，当前 fork 插件继续使用重命名名称而无需迁移。名单会有意为每条受支持的 Cordis 事件保留两个名称，载荷不变。维护者只有在确认上游约定、补充针对性测试并重新评估命名例外后，才能扩展该基线。
