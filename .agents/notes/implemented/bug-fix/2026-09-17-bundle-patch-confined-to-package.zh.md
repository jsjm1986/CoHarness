# Agent Note: bundle 的 patch 声明不得越出包目录

Status: implemented

[English](2026-09-17-bundle-patch-confined-to-package.md) | 中文

## Problem

`loadProfile` 把 bundle 声明的 `dsh.bundle.patch` 直接 join 到解析出的包目录上，没有任何越界检查。绝对路径或带 `..` 的声明会把组合层指向 bundle 之外的文件——越过 bundle 契约声明的包内边界，读到 profile 作者从未同意组合的文件。

## Decision

声明的 patch 相对包目录解析且必须留在包内：绝对声明或解析后越出包的相对路径在 profile 加载时明确失败，报错点名 bundle 与越界声明。bundle 内容按契约即包内资源，所以这是执行格式既有承诺的边界，而非新增限制。

## Alternatives considered

**归一化并放行越界。** 否决：声明的 patch 属于 bundle 自身 manifest——声明越出包目录是配置错误，静默接受会掩盖它。

**只在 bundle 编写期约束。** 否决：profile 会组合任意已安装的包；加载边界才是执行承诺的地方。

## Consequences

manifest 写 `../anything` 或绝对路径的 bundle 会在 profile 加载时以精确报错失败，而不是组合外来文件；所有在树 bundle 声明的都是 `./cordis.patch.yml`，不受影响。

## Verification

`profile.spec.ts` 构造一个 `dsh.bundle.patch` 先是 `..` 路径、再是绝对路径的 bundle，断言 `loadProfile` 两者都拒绝。
