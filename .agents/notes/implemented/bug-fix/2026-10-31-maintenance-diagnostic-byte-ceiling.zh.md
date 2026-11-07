# Agent Note: 维护诊断字节上限

Status: implemented

[English](2026-10-31-maintenance-diagnostic-byte-ceiling.md) | 中文

## Problem

PostgreSQL 维护命令可能产生大块诊断输出和多字节文本。即使保留的字符串看似很短，按字符计数或不检查整块追加都会超出字节上限。

## Decision

命令持有者最多保留八 KiB 的 UTF-8 stderr 字节，每个到达的数据块在保留之前裁剪。格式化只使用完整的 UTF-8 前缀；被上限截断的码点不纳入结果。既有错误行选择和进程失败上下文保持原样。此限制针对 stderr，独立于命令和退出状态上下文。

## Alternatives considered

**按字符计数。** UTF-8 字符的编码长度不同，字符上限无法限制保留的字节数。

**完整追加最后一块。** 一次原生读取就可能超出剩余预算。

**对裁剪后的缓冲区使用替换解码。** 尾部不完整码点会添加命令未输出的文本。保留尾段也会改变既有的前缀选择。

## Consequences

ASCII 和多字节失败详情都符合既有字节上限，边缘不引入替换字符。刚好达到上限的输出保持完整。可运行命令回放通过真实子进程检查 ASCII、中文、emoji 和精确上限对照；这项修改不改变 PostgreSQL 凭据或进程生命周期规则。
