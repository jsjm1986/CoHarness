# Agent Note: 工作树尝试结果的发布

Status: implemented

[English](2026-11-20-worktree-attempt-publication.md) | 中文

## Problem

Git 拒绝重试时，[Forge 面板](../../../../packages/experimental/client-ui-forge/README.zh.md)先发布尝试结束，再发布失败结果。WebKit 可能等到收到其他流数据才交付第二帧。卡片显示尝试已停止，真正的失败和 Git 输出仍未显示。

## Decision

有消息等待的尝试由该消息负责发布最终结果。重试可以接收下一次尝试后，再发布已停止或失败的状态。请求撤回或完成时，浏览器根据已记录的请求和工作树关闭卡片。

## Alternatives considered

**先发送尝试结束，再发送结果。** 中间状态会让失败看起来像已停止，也可能在等待逻辑能受理前提前显示重试。

## Consequences

订阅方收到可以立即操作的失败或已停止结果。继续使用原检出目录或进入新工作树时，记录该结果的状态同时清除创建卡片。

## Verification

可选功能的浏览器回放停止被夹具拦住的 Git 调用，删除选定的基准分支，重试并读取 Git 失败，再在原检出目录继续发送消息。另一个会话创建工作树，并在新目录中发送首条消息。
