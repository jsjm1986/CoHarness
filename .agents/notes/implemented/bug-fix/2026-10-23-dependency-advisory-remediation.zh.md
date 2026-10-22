# Agent Note：修复运行时与构建工具的依赖公告

Status: implemented

[English](2026-10-23-dependency-advisory-remediation.md) | 中文

## 问题

锁定的依赖图包含存在漏洞的生产 YAML 解析器，以及多个受影响的构建和测试包。仅供构建使用的 `extract-zip` 还有两条路径遍历公告，且上游没有发布修复版本。

## 决策

工作区保留 vendored 源码固定版本，并通过 `js-yaml` override 将所有消费方统一解析到 5.5.0，避免出现重复且名义上不兼容的 `Schema` 类型。VitePress 使用 Vite 6.4.5，Vite 8 消费方使用 8.2.4；esbuild 和 uuid 分别解析到 0.25.0 和 11.1.1。Web 应用和网站直接声明已修复的 Vite 6 版本线。webserver 测试夹具使用 `selfsigned` 5.5.0，移除了其易受攻击的 `node-forge` 依赖。

根构建移除 `extract-zip`，改用 `yauzl` 流式读取 ZIP 条目。解压会拒绝路径遍历与绝对路径、符号链接、特殊文件、重复目标、穿过非目录的路径，以及不支持的 wheel 安装方案。解压前仍会校验锁定归档的摘要。

## 考虑过的替代方案

**由于运行时归档有哈希锁定而保留 `extract-zip`。** 摘要校验会将归档内容绑定到构建锁，但不会消除解压器不安全的路径处理。替代实现会在流式写入目标的同时校验每个条目。

**只升级审计点名的消费方。** 将传递依赖升级到已修复的 `js-yaml` 版本，仍会与较新的工作区消费方产生重复且名义上不同的 `Schema` 类型。工作区统一版本能同时修复生产解析器并统一 TypeScript 类型。

## 后果

网站和应用构建现在使用同一条已修复的 Vite 主版本线。UUID 消费方跨越旧声明范围统一使用修复版本。ZIP 解压只支持普通文件和目录，不会从归档重建链接或特殊文件系统条目。

## 验证

针对公共 registry 的根 npm audit 与生产 npm audit 均报告零条公告。[`prepare.spec.ts`](../../../../scripts/primary-runtime/prepare.spec.ts) 覆盖普通 wheel 解压、大文件流式写入、不支持的安装路径、符号链接、路径遍历与重复路径。webserver TLS 测试和构建后 Web profile 测试使用已安装的 `selfsigned` 版本运行；网站与 Web 应用构建验证已修复的 Vite 依赖图。
