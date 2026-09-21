---
description: "供浏览器安全客户端代码使用的跨运行时 UUID 生成与有界字节编码。"
kind: "package-library"
---

# dsh-util-crypto

[English](README.md) | 中文

零依赖、可在浏览器中使用的 UUID 与字节编码辅助函数。UUID 使用 `crypto.getRandomValues`，因此普通 HTTP 页面和 worker 也能使用；客户端代码不能依赖只在安全上下文提供的 `crypto.randomUUID`。该包是纯库，不是 Cordis service 或插件。

## 概述

零依赖、可在浏览器使用的 UUID 与字节编码辅助函数。UUID 铸造基于 `crypto.getRandomValues`——所有发布上下文都提供的那个随机原语。`crypto.randomUUID` 是安全上下文限定的 Web API：经普通 HTTP 在局域网地址上提供的页面或 worker（浏览器预览部署）根本没有这个方法，必须在那里运行的代码不能调它。全仓 `no-restricted-properties` lint 规则把 `crypto.randomUUID` 的调用者指到这里；只跑在 Node 的代码从 `node:crypto` 导入 `randomUUID` 维持原样。

## API

```ts
import { bytesToBase64, randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| 导出 | 作用 |
|---|---|
| `randomUUID()` | 使用 `crypto.getRandomValues` 生成 RFC 9562 v4 UUID。 |
| `bytesToBase64(data)` | 以有界分片编码标准 base64。 |
| `Uuid` | 五段式 UUID 字符串类型。 |

## 模型体验

间接地，经由用它铸造请求、会话与附件标识符的消费方，这些标识符均不作为语义内容进入提示词。

#### KV Cache 影响

无直接失效；铸造标识符的消费方自行负责其请求变化。

## Known Limitations and Deferred Work

- **仅支持 v4**——命名空间和其他 UUID 版本不属于该工具。
- **唯一性是概率性的**——碰撞检测仍由消费方负责。

**运行时不变式：** 不发布伴生入口。这个纯工具不持有事件流或可变运行时数据；其值运算由单元测试覆盖。
