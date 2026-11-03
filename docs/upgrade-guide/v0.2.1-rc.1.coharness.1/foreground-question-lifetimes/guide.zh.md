---
kind: upgrade-guide
description: "前台回答器收到服务持有的取消信号，不能完成已撤回的提问。"
---

# 将前台答案限定在其有效提问内

[English](guide.md) | 中文

## 变更

`UserQuestionService.ask()` 为回答器提供合并调用方取消、服务撤下及原调用 Agent 释放的信号。它可能不是调用方原来的信号对象。取消结算不等待忽略信号的回答器，迟到答案会被拒绝。保留的已撤下服务引用会以 `ASK_ABORTED` 拒绝新提问；已删除或替换的 Agent 不能接受旧答案。

前台提问及定时等待在结算前会阻止空闲回收。计划评审还会在选择退出前重新检查取消状态及原 Agent 是否仍是存活实例。方法签名、问答字段、Session 格式及设置保持不变。

## 迁移

1. 重建匹配的 `@deepseek-ai/dsh-user-questions` 与 `@deepseek-ai/dsh-plan-mode` 产物。
2. 更新自定义 `user-questions/request` 回答器，监听实际收到的信号。比较取消状态，而非与调用方信号的对象身份，并在中止时释放回答器自己的 UI 或传输工作。
3. 验证取消或撤下待决提问后，即使迟到批准返回也不会生效。验证正常批准仍可离开计划模式，且不同 Agent 的问题相互隔离。参见[提问服务](../../../../packages/interaction/user-questions/README.zh.md)。
