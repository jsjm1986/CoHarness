# dsh-brand

[English](README.md) | 中文

`Branded<B>` 与 `BrandedNumber<B>` 名义类型原语：一个微小的**仅类型**包，无运行时代码，也不依赖其他 harness 包；所有拥有易混淆跨边界值的包都会共享它。

## `Branded` 是什么

品牌使结构相同的字符串或数字在类型层面不可互换：`SessionId` 不能传给期望 `CallId` 的位置，事件序号也不能传给要求日志偏移的位置，尽管它们在运行时都只是普通的 `string` 或 `number`。

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

export type SessionId = Branded<'SessionId'>

/** Brand a string as a SessionId (a plain cast — zero runtime cost). */
export function SessionId(id: string): SessionId {
  return id as SessionId
}
```

构造操作通过所属包中各品牌专用的工厂完成。比较、日志记录、JSON 序列化和协议格式（wire format）的行为与普通字符串相同；品牌信息会在编译时被擦除。

### 为数字添加品牌

在所属包中声明数字品牌，并且只在该包接纳该数字之后再应用它：

```ts
import type { BrandedNumber } from '@deepseek-ai/dsh-brand'

export type SessionSeq = BrandedNumber<'SessionSeq'>

/** Brand a validated non-negative safe integer as a SessionSeq. */
export function SessionSeq(value: number): SessionSeq {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('SessionSeq must be a non-negative safe integer')
  return value as SessionSeq
}
```

所属工厂在断言之前校验非负安全整数范围等要求。比较、算术、日志记录、JSON 序列化与线上传输保持普通数字的行为；算术运算得到的是无品牌数字，所属方必须重新接纳后才能让它回到该领域。

## 策略：为跨包边界的值添加品牌

包为自己拥有的值添加品牌：`CallId` 位于 `dsh-llm`，共享的 agent/会话 `SessionId` 位于 `dsh-session`，`JobId` 位于 `dsh-jobs`，`SessionSeq` 与 `SessionLogOffset` 亦位于 `dsh-session`。为可能与同一原始类型的其他值混淆的跨包值添加品牌，但无需为每个字符串或数字都添加。

该包只负责这一原语。保持无依赖意味着，例如 `dsh-jobs` 可以为 `JobId` 使用品牌类型，而无需仅为使用 `Branded` 而导入不相关的功能包。
