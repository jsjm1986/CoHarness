# Agent Note: 激活校验 Gateway 运行时链接，model-governance 解除版本钉死

Status: implemented

[English](2026-10-19-release-runtime-links-and-governance-peers.md) | 中文

## 问题

同一个生产 release 暴露出两个缺陷。`dsh-model-governance` 声明了精确的 `0.1.5-alpha.1.coharness.1` 版本 peer 依赖，而产品版本已升到 `0.2.1-rc.1.coharness.1`，插件加载器于是在每个 agent 会话里以不兼容告警禁用它——模型授权与用量上报从未运行。另外，`release-control.sh` 的 `validate_release` 校验载荷文件，但不查编译后 ESM 依赖图所要解析的 `gateway/node_modules/@deepseek-ai/*` 链接。未经 `build:production`（创建这些链接的步骤）组装的 release 能通过载荷校验、切换 `current`，然后才因无法解析 import 启动失败——缺陷一直走到线上健康检查才暴露，而不是在激活时被拒绝。

## 决策

该插件的 `peerDependencies` 改用 `*`，与 `dsh-directory-guard`、`dsh-steward-tools` 一致。精确钉版靠手工维护、每次版本升级都会过时，等于静默禁用已交付的插件；加载器检查仍然是有维护范围的兼容性门。

`validate_release` 现在额外要求每条 scoped 运行时链接能解析到包清单。校验名称与 `scripts/build-production.ts` 的 `GATEWAY_RUNTIME_PACKAGES` 对应——`cordis`、`schemastery` 以及编译后 Gateway 所导入的九个 `dsh-*` workspace 包——缺链接的 release 会在 `current` 切换前被拒绝，错误信息指出缺失条目。

## 备选方案

**把 peer 钉到当前 release 版本。** 拒绝：没有任何工具重新生成这些值，下次 bump 会重演同样的钉版过时；`*` 表达的是真实约定——插件随构建它的 release 一起交付。

**链接不进载荷校验、靠健康检查回滚兜底。** 拒绝：不完整的 release 会先启动并崩溃，再由回滚路径恢复旧版，载荷缺陷变成了真实的线上中断窗口；提前拒绝让激活保持原子性。

## 验证

改后的控制器通过 `bash -n`。用一个伪造的 release 目录做 `activate` 桩测：载荷文件齐全但缺运行时链接时被拒绝并指出缺失的链接名；补齐十一条链接后激活越过校验、进入 launchd 与健康验证阶段。

## 后果

治理插件在任意 release 版本下都能加载，版本升级不会再静默丢掉模型授权与用量上报；真正的 API 不兼容仍是构建与 typecheck 层面的问题，而非加载器问题。链接清单在 TypeScript 构建脚本与 shell 控制器之间重复了一份——`GATEWAY_RUNTIME_PACKAGES` 新增条目时须同步 shell 数组，注释里已指向权威清单。
