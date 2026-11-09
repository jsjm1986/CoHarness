# Agent Note: 编码 preamble 以 FullLanguage 为前提

Status: implemented

[English](2026-11-07-pwsh-preamble-language-mode.md) | 中文

## Problem

`pwsh` 工具的编码 preamble 通过类型成员写入设置 `[Console]::OutputEncoding` 与 `$OutputEncoding`。Windows ACL 沙箱可以把 shell 限制进 ConstrainedLanguage 模式，两处写入在该模式下以 `CannotCreateTypeConstrainedLanguage` 被拒。preamble 每次调用都会抛错:输出仍是 UTF-8(pwsh 7 默认),但 stderr 每次多出一对非终止错误;在 Windows PowerShell 5.1 兜底上,OEM 代码页仍从噪声中漏出。

## Decision

[ENCODING_PREAMBLE](../../../../packages/shell/pwsh-local/src/index.ts) 改为在命令前置 `if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { … }`,不再无条件执行两条赋值。`$ExecutionContext` 是引擎内建对象,在任何语言模式下可读;ConstrainedLanguage 在求值时强制成员写入,被跳过的分支不可能抛错。控制流块不产生变量作用域,`$OutputEncoding` 的绑定与之前一致;preamble 仍只占第 1 行,错误行号保持准确。

## Alternatives considered

**在 runner 里设置 `__PSLockdownPolicy` 或强制 FullLanguage。** 受限子进程的语言模式属于沙箱的安全决策,执行器不得放宽它。

**通过 CLM 允许的路径固定 UTF-8。** `[System.Text.Encoding]::UTF8` 静态访问与属性赋值同样被拒,`chcp 65001` 也无法改向已运行进程——不存在合法固定手段,跳过是唯一选项。

## Consequences

pwsh 7 受限 CLM 时默认仍输出 UTF-8 且 stderr 干净。Windows PowerShell 5.1 受限 CLM 时无法固定,仍输出 OEM 代码页——已记入包 README 的已知限制。一条无密钥 spec 可在任意平台进入 ConstrainedLanguage 并断言 preamble 无输出,未守卫形态无法静默回归。早于此变更的主机部署可对 `lib/index.js` 中唯一的字面量做字符串替换来采用该修复。
