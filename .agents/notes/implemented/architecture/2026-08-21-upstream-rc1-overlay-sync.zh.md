# Agent Note: 上游 rc.1 与本地治理覆盖的同步

Status: implemented

[English](2026-08-21-upstream-rc1-overlay-sync.md) | 中文

## Problem

本地产品是一个基于 rc.8、带 Gateway、组织提供方治理、BYOK 和浏览器配置覆盖的 fork。上游 `dsh-v0.1.1-rc.1` 修改了凭据记录、授权流程和模型能力声明。直接用 tag 替换 fork 会移除本地行为；继续保留旧契约则会让模型设置界面和提供方适配器无法与官方版本兼容。

## Decision

fork 在所属包边界采用官方 rc.1 契约，并把产品专属行为保留在现有覆盖层中。上游参考为 tag `dsh-v0.1.1-rc.1`，提交 `528c682e061696f5a160f363f236ecbf53cbd006`。

- DeepSeek 保留路由级 `reasoningEffort`，并增加模型级 `inputModalities`，包括 `deepseek-v4-flash-vision-exp`。pi-ai 使用模型级 `input` 和 `reasoningEfforts`；两套适配器词汇分别校验。
- 凭据采用 rc.1 记录模型（`CredentialKey`、API key 与 grant 记录、记录修改、枚举、删除、v1 YAML、锁、权限，以及从预发布 flat 文件迁移）。组织 `DSH_*` 提供方仍为只读，并在拥有某个引用时继续优先于个人记录。
- 授权是独立的 `ctx.authorization` seam。pi-ai 登录 flow 通过 `ctx.credentials` 提交记录，提供 `openai-codex` 等官方 OAuth provider，并保留每键一次尝试和收容式结算语义。
- Host 与 Client 事件转发使用官方 `credentials/reference-updated` 名称；生成目录、子系统参考、模型编辑器和 Gateway 测试使用同一个 owner 事件。
- Session projection 采用 rc.1 的双层表示：持久化 registry state 从事件日志校验并推进；可选的 wire view 为 Host/Client 传输和 snapshot 派生。checkpoint 只保存 state 值和版本，wire 值不会被当作持久化 state。
- workspace 包清单和 lockfile 统一报告 `0.1.1-rc.1`；本地 Gateway、组织、BYOK、文档、协作和部署覆盖保持不变。

预发布存储策略仍然明确：v1 凭据加载器会在启动时迁移旧 flat 文件，但不会为其他预发布磁盘格式提供通用兼容承诺。部署启动新 bundle 前应先备份凭据文件。

## Verification

凭据、授权、pi-ai、DeepSeek 和模型治理定向套件通过，共 574 个测试。Host library 构建、TypeScript 类型检查、源码 lint、Cordis 与模块目录、hygiene 以及文档门禁覆盖已发布包和浏览器投影。

## Alternatives considered

**用 rc.1 tag 替换 fork。** 拒绝，因为这会移除仍属于部署组合的 Gateway、组织提供方、BYOK 和其他本地产品能力。

**在兼容 shim 后面保留 rc.8 的模型和凭据契约。** 拒绝，因为设置界面和适配器仍会发出非官方字段，而预发布仓库明确允许格式变更，不要求无限期维护 shim。

**把 DeepSeek 思考配置当作模型级 `reasoningEfforts` 字段。** 拒绝，因为官方 DeepSeek 适配器拥有路由级 `reasoningEffort`，模型级 `reasoningEfforts` 属于 pi-ai 能力元数据。

## Consequences

源码与生成工件现在描述同一套 rc.1 契约，本地治理仍在扩展点上明确存在。必须重新构建 bundle 并重启进程才能加载这些变更；已经运行的进程不会自动加载新的 `lib/` 输出。凭据迁移发生在启动时，应作为带备份的部署操作处理，而不是运行中更新。

本地 `frontend-static` 覆盖层有意保留未被命名路由声明的浏览器路径的 SPA 行为：返回 `index.html` 且 HTTP 200，让客户端路由继续工作。这与严格静态文件 404 不同，但属于产品行为，不是上游同步遗漏。
