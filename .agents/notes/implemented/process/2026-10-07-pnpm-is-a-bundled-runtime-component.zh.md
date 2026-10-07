# Agent Note: pnpm 依赖是打包进运行时的组件

Status: implemented

[English](2026-10-07-pnpm-is-a-bundled-runtime-component.md) | 中文

## Problem

`pnpm` 在根 `package.json` 和 [`packages/boot/plugin-manager/package.json`](../../../../packages/boot/plugin-manager/package.json) 中看似普通的 `devDependency`，自动化依赖更新因此对等对待它并提出 major 升级（11.7.0 → 12.3.4 的 PR 使全部 23 个 CI 车道失败）。它并不普通：该 npm 包的字节会随 Python 运行时载荷分发，且多处构建与测试消费者直接调用其 JavaScript 入口。major 升级是运行时组件更换，而 pnpm 12 更是架构变更——npm 包变成占位 bin 加上按平台的 `@pnpm/exe.*` 二进制并附带 install 脚本，被默认拒绝的 `allowBuilds` 策略在安装期拦截，其 `bin/pnpm.mjs` 也不再是可运行的 JavaScript 实现。

## Decision

`pnpm` 依赖维持在 11.x 线，直到专项迁移决定打包组件的分发形态。[`.github/dependabot.yml`](../../../../.github/dependabot.yml) 对 `pnpm` 忽略 `version-update:semver-major`（minor 与 patch 更新照常进入），挂起的 major PR 已带本分析关闭。

四个消费者钉住了迁移必须满足或替换的 JavaScript 入口契约：

- [`scripts/primary-runtime/prepare.ts`](../../../../scripts/primary-runtime/prepare.ts) 把 `require.resolve('pnpm')` 的包目录复制进运行时载荷为 `dependencies/pnpm/`；[`primary-runtime.ts`](../../../../packages/boot/workspace-dependencies/src/primary-runtime.ts) 解析 `dependencies/pnpm/bin/pnpm.mjs`，`verify-installed` 执行 `node pnpm.mjs --version` 将 `pnpm` 组件版本记入载荷清单。
- [`scripts/build-exe-for-python-sdk.ts`](../../../../scripts/build-exe-for-python-sdk.ts) 的 `pnpmInvocation()` 只扫描 `pnpm.mjs`/`pnpm.cjs`，pnpm 不提供 JavaScript 入口时直接报错。
- [`manager.spec.ts`](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) 以 `node --expose-internals <pnpm.mjs>` 跑真实安装；plugin-manager 操作外部拉起 `pnpm` 并按其 CLI 输出分类失败。
- [`python/sdk-runtime`](../../../../python/sdk-runtime/package.json) 将复制的包目录作为运行时载荷的一部分分发。

迁移必须先选定分发形态——维护中的 JavaScript 构建、按平台的可执行文件，或由部署环境自带 pnpm——然后重新验证上述每个消费者，补上 install 脚本白名单条目，并对新 CLI 表面审计 plugin-manager 的失败分类（pnpm 12 改名了错误码，如 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 改为 `ERR_PNPM_OUTDATED_LOCKFILE`，且有已记录的 reporter 一致性缺口）。

## Alternatives considered

- **把 `pnpm` 加进 `allowBuilds` 并接受升级。** 只修了安装期门；JavaScript 入口消费者面对 pacquet 包仍会坏，而为一个打算持有的组件开白名单会削弱该门的信号。
- **关掉 major PR 但不加忽略规则。** Dependabot 每个调度周期都会重开同一升级，重复讨论已定结论。
- **现在迁移到 pnpm 12。** 为时过早：分发形态选择和一致性审计是专项工作，且上述消费者使用的 11.x 线仍在维护。
- **去掉打包的 pnpm、要求部署环境自带。** 属于同一迁移决策的分发契约变更，不是解锁版本升级的变通手段。

## Consequences

Dependabot 不再提出 pnpm major 升级，minor 与 patch 更新继续。迁移清单——分发形态、`allowBuilds`、四个入口消费者、CLI 一致性——记录于此，不必再按 PR 重新发现。同一忽略机制也持有 `@vitejs/plugin-react` 的 major，其版本 6 要求 `vite: ^8.0.0`；该门禁在 dependabot 配置注释及其已关闭的 PR 中自足说明。
