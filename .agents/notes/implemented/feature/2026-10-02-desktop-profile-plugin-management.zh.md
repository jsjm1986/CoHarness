# Agent Note: Desktop 安装的载体可管理保留 desktop profile 的插件

Status: implemented

[English](2026-10-02-desktop-profile-plugin-management.md) | 中文

## Problem

`desktop` profile 名称保留给 Electron 持有的应用 profile：启动器会拒绝针对它的启动、配置 dump 和插件管理请求。未来的 Desktop 安装需要经由自带的捆绑命令管理该 profile 的插件，而不把同样的权力交给公开的 `dsh` 二进制，也不由 CLI 初始化一个归应用所有的 profile。

## Decision

[`parseDshArgs`](../../../../apps/cli/src/args.ts) 与 [`runCli`](../../../../apps/cli/src/bin.ts) 接受 `manageDesktopProfile`——一个安装方持有的开关。开启后，`plugin --profile desktop` 正常解析而不再报错，名称的任意大小写变体归一为 `desktop`；未开启时行为不变，npm 版 CLI 继续拒绝该 profile。[`runPlugin`](../../../../apps/cli/src/plugin.ts) 要求 Desktop profile 已存在——解析目录下有 `package.json`——并引导操作者经由应用初始化，而非通用模板。无论开关与否，针对该名称的启动与配置 dump 请求依旧保留。

## Alternatives considered

- **由通用模板自动初始化 desktop profile。** 否决：该 profile 的组合归应用所有，CLI 创建的模板会与之竞争。
- **单独的插件管理二进制。** 否决于 `runCli` 开关方案：安装的载体复用同一捆绑 CLI，而非并行入口。
- **为载体解锁全部 `desktop` 操作。** 否决：启动与配置检查保持保留，任何 CLI 路径都不能启动或 dump 应用持有的 profile。

## Consequences

公开 CLI 表面不变；只有 Desktop 安装的载体才选择启用。当前树内没有调用方传入该开关——该能力先于 desktop 应用休眠发布。对 desktop 名称的插件管理从不初始化全新 profile。
