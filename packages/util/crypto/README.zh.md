---
description: "供浏览器安全客户端代码使用的跨运行时 UUID 生成与有界字节编码。"
kind: "package-library"
---

# dsh-util-crypto

[English](README.md) | 中文

零依赖、可在浏览器中使用的 UUID 与字节编码辅助函数。UUID 使用 `crypto.getRandomValues`，因此普通 HTTP 页面和 worker 也能使用；客户端代码不能依赖只在安全上下文提供的 `crypto.randomUUID`。该包是纯库，不是 Cordis service 或插件。

## API

```ts
import { bytesToBase64, randomUUID, type Uuid } from '@deepseek-ai/dsh-util-crypto'
```

| 导出 | 作用 |
|---|---|
| `randomUUID()` | 使用 `crypto.getRandomValues` 生成 RFC 9562 v4 UUID。 |
| `bytesToBase64(data)` | 以有界分片编码标准 base64。 |
| `Uuid` | 五段式 UUID 字符串类型。 |

## Model Experience

间接地，经由生成请求、会话和附件标识符的消费方；这些标识符不是提示词语义内容。

#### KV Cache effect

无直接影响；请求变化由生成标识符的消费方负责。

## Known Limitations and Deferred Work

- **仅支持 v4**——命名空间和其他 UUID 版本不属于该工具。
- **唯一性是概率性的**——碰撞检测仍由消费方负责。
