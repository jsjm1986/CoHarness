# @deepseek-ai/dsh-typert-registry

[English](README.md) | 中文

生成的 Typert 产物所用的运行时注册表。每个注册项包含某个包在一个 face 上的业务反射信息，以及可选的运行时 Zod schema；`ctx.typert` 会以原子方式同时注册两者，并在发起调用的 Cordis fiber 释放时一并移除它们。TypeScript 分析和代码生成由 [`dsh-typert-generator`](../generator/README.zh.md) 负责。

包反射信息以 `<package>#<face>` 为键。schema 以 `<package>#<name>` 为键，并保留生成方的 Zod 实例。系统按需在消费方边界计算 JSON Schema。

## 概述

`dsh-typert-registry` 让生成的 Typert 产物在运行时可按需查询：每个包的反射、惰性 Zod schema factory 与 Remote 调用描述符都保存在稳定键下。消费方首次请求 schema 时才会物化并缓存它。注册是原子且按 fiber 作用域的：贡献要么整体落地要么完全不落地，并在注册组件卸载时自动撤销。同一服务还托管 Remote 调用所经由的 lookup 与作用域 Context 提供方注册表。它不执行 TypeScript 分析，也不生成 schema；这些由生成器与 loader 负责。

## 公开 API

- `TypertRegistry` 是默认插件，并提供 `ctx.typert`。
- `ctx.typert.lookups.register()` 注册由业务包拥有的协议声明和默认解析器；`configure()` 注册由宿主组合拥有且可异步执行的解析器。两者的生命周期相互独立：配置可以先于提供方注册，卸载配置会恢复默认策略。
- `ctx.typert.contexts.registerHost()` 和 `configureHost()` 对具作用域的上下文身份采用同样的所有权划分；`registerClient()` 提供对应的客户端上下文绑定器。
- `register(contribution)` 会在提交任何内容之前拒绝格式错误的标识，以及重复的包与 face 组合键或 schema 键，随后返回 Cordis effect 提供的同一资源释放函数。
- `get(key)`、`resolve(key)` 和 `list(filter?)` 查询当前有效的 schema。`resolve()` 能区分格式错误的键、未注册的包，以及已注册但未以该名称提供 schema 的包。
- `getPackage(packageName, face?)` 和 `listPackages(filter?)` 查询生成的服务、事件和对象反射信息；默认 face 为 `host`。
- `toJSONSchema(key, params?)` 使用 `z.toJSONSchema()` 投影当前有效的 schema，且不缓存结果。
- `typertKey()` 和 `typertPackageKey()` 构造两种稳定的标识形式。

`@deepseek-ai/dsh-typert-registry/types` 子路径包含注册项和记录的纯类型约定。[`dsh-typert-loader`](../loader/README.zh.md) 会在 Loader 组合中发现并注册生成的宿主侧产物；其他组合所有者可以直接调用 `ctx.typert.register()`。

## 不变量

**运行时不变量：** 未发布配套入口。贡献原子地注册并随调用 fiber 撤回，因此注册表内容恰好是释放规格所证明的实时 effect 集。

## 模型体验

无，因为该运行时类型注册表的消费方（cordis_inspect、wire faces、门禁）拥有注册表内容的任何模型可见投影。

#### KV Cache 影响

无直接影响；把反射或 schema 放入请求的消费方负责由此产生的前缀变化。

## 已知限制与暂缓事项

- 注册表存储生成的反射信息，但不会合并宿主侧与客户端侧的图，也不会解析 TypeScript 引用；这些由分析器和产物输出器负责。
- schema 键不包含 face，因为宿主侧和客户端侧在不同的上下文中运行。若在同一上下文中注册来自两个 face 的同名 schema，系统会将其作为重复项拒绝。
