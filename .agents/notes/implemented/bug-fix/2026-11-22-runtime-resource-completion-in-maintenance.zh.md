# Agent Note: 维护期间的 Runtime 资源完成回执

Status: implemented

[English](2026-11-22-runtime-resource-completion-in-maintenance.md) | 中文

## Problem

Runtime 释放已接纳的进程时，需要在停机前向 Gateway 上报完成结果。维护写入门禁对已认证的回执返回 503。Runtime 会在资源清理期限内重试，可能还没发布落盘回执就达到监督程序的停机期限。

## Decision

维护期间，Gateway 在认证 Runtime 代次并核对当前数据库写入纪元后接收资源完成回执。原有记账事务核验该代次持有相应的预留额度。正常服务期间沿用现有写入门禁。

## Alternatives considered

**延长停机期限。** 维护门禁继续拒绝回执，等待更久也无法在维护窗口内结算额度。

## Consequences

Runtime 可以在退出前上报已有资源的结束结果。资源接纳和 Session 写入经过各自的常规门禁。[不确定的资源记账](2026-11-01-uncertain-resource-cancellation.zh.md)继续保留占用，直到资源所有者提供清理证据。

## Verification

Gateway HTTP 测试验证维护期间可接收已认证的回执，并拒绝未认证的回执、过期写入纪元、新资源申请和 Session 追加。
