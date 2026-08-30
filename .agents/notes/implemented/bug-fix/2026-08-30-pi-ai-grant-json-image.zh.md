# Agent Note: Store pi-ai grants as JSON-compatible values

Status: implemented

[English](2026-08-30-pi-ai-grant-json-image.md) | 中文

## 问题

pi-ai OAuth grant 可能把可选成员显式设为 `undefined`。凭据记录校验器只接受 JSON 值，因此授权成功后仍会拒绝保存这些 grant，尽管缺失成员并不携带信息。

## 决策

pi-ai 凭据适配器在 `modifyRecord` 前把 grant 投影为 JSON 形式：自有对象中值为 `undefined` 的属性被省略，数组中的 undefined 元素变为 `null`，与 `JSON.stringify` 一致。外部原型对象和非有限数字不做强制转换，因此真正不可表示的载荷仍会在持久化边界失败。

## 考虑过的替代方案

**列出已知 OAuth 字段白名单。** 不采用：pi-ai 可以增加提供方特有成员，白名单会静默丢失这些字段。

**原样保存 grant 对象。** 不采用：显式 undefined 成员不是有效的持久 JSON，会让提供方成功后登录仍然失败。

**把所有值都通过 JSON.stringify 强制转换。** 不采用：日期、非有限数字和外部对象应保留给校验器发现，而不是静默改变。

## 影响

常见的 Copilot 风格 grant 可以正常保存，同时提供方自有字段仍保持不透明。非法的非 JSON 值继续产生可操作的存储错误。

## 测试

pi-ai auth 测试覆盖嵌套对象中的 undefined 成员、数组中的 undefined 元素、带 scope 的记录寻址，以及最终保存的记录内容。
