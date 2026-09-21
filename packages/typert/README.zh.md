# Typert

[English](README.md) | 中文

Typert 将源代码分析、运行时存储和 Loader 发现机制分离。

| 包 | 职责 | Cordis 键 |
|---|---|---|
| [`registry/`](registry/README.zh.md) | 存储运行时包反射和 schema | `ctx.typert` |
| [`loader/`](loader/README.zh.md) | 发现 Loader 条目并注册生成的宿主产物 | 使用 `ctx.loader`、`ctx.typert` |
| [`generator/`](generator/README.zh.md) | 从源代码类型生成运行时产物 | 构建时库 |

[Typert 子系统参考](../../docs/subsystems/typert.zh.md)记录由协议与注册表类型生成的字面公共契约。


## 概述

借助 Typert 组，Client 环境能以类型化方法调用 Host 能力，并在无需手写协议代码的情况下共享生成的 schema 与反射信息。构建时生成器把源代码类型声明转换为与编译器无关的模型与运行时产物，运行时注册表保存这些产物，Loader 集成则在 Loader 组合中自动注册它们。共享的协议包提供 Remote 调用声明——装饰器、wire 描述符、编解码器与提供方约定——供业务包、生成产物、Host Gateway 与 Client API 共同消费。本页是四个包的索引；每个包的 README 负责各自的配置、用法与限制。
