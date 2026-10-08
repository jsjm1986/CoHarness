# Agent Note: 通过兼容的 11.x 分发修复 pnpm 提升式安装器

Status: implemented

[English](2026-10-08-pnpm-hoisted-installer-fix.md) | 中文

## Problem

pnpm 的 hoisted linker 曾存在上游 rename 竞态（pnpm/pnpm#12880）：目标路径嵌套的并发 hoist-copy 可能让父级的 swap-rename 带走兄弟节点的 `_tmp_*` 暂存目录，失败方以 `ERR_PNPM_ENOENT` 退出。热重试并不可靠，因此 [scripts/wine-windows-gates.sh](../../../../scripts/wine-windows-gates.sh) 曾携带 `taskset -c 0` CPU 亲和钉法与 `ERR_PNPM_ENOENT` 重试循环来串行化暂存 rename——那是绕过真实安装器缺陷的 Linux 专用权宜手段而非修复。上游在 pnpm 11.28.4 中修复了嵌套 hoist 操作本身（pnpm/pnpm#14242）。同一版本还改变了被忽略构建脚本的记录位置：pnpm 改将未决定的构建记录到 `node_modules/.modules.yaml` 并通过 `pnpm ignored-builds` 报告，使插件管理器原有的占位符式待批准发现在该记录形态下看不到它们。

## Decision

仓库在根与 `native/system` 的 `packageManager` 字段以及根与 [`packages/boot/plugin-manager/package.json`](../../../../packages/boot/plugin-manager/package.json) 的 devDependency 中统一固定 `pnpm@11.28.4`——携带上游 copy 修复的兼容 11.x 版本；插件管理器还在运行时依赖 `@pnpm/building.policy`，使下面的批准路径按 pnpm 自身规则评估。Wine gate 脚本执行单次不可变安装，不再使用亲和钉法或 rename 重试循环，失败时仍报告 `install.log` 尾部。[`scripts/pnpm-runtime-component.spec.ts`](../../../../scripts/pnpm-runtime-component.spec.ts) 固化分发形态：两处 `packageManager` 字段与两处 devDependency 的版本一致、`require.resolve('pnpm')` 能解析到包元数据、payload 安装不运行生命周期脚本、`bin/pnpm.mjs` 可在 `process.execPath` 下启动——包括一份没有 `PATH` 的迁址 payload 副本。

插件安装失败时，插件管理器在文件回滚之前调用 `capturePendingBuilds`：它读取工作区策略与 `node_modules/.modules.yaml`，通过受维护的 `@pnpm/building.policy` 包（`createAllowBuildFunction`、`unapprovedIgnoredBuilds`、`allowBuildKeyFromIgnoredBuild`）按 pnpm 自身规则评估，在 profile 锁下把未决定的键持久化为未决定占位符，且绝不改写已有的 true/false 决定。持久的 `allowBuilds` 条目因此在回滚与 `node_modules` 清理后仍然存活，批准面继续校验待批准键而不自行匹配来源选择器。

11.x 系列保持了 JavaScript 打包分发契约：`exports['.']` 解析出 `package.json`，`bin/pnpm.mjs` 导入随包分发的 `dist` bundle，且 payload 安装不触发 `preinstall`/`install`/`postinstall`，因此 deny-by-default 的 `allowBuilds` 策略无需豁免。[pnpm is a bundled runtime component](2026-10-07-pnpm-is-a-bundled-runtime-component.zh.md) 对 pnpm 12 的主版本暂留不变——其分发形态与 CLI 一致性审计仍是独立的迁移决策。

## Alternatives considered

- **保留 taskset 钉法。** 它在生效处把整个安装串行化在 `availableParallelism()-1` 之后，并让竞态继续在每一个 hoisted-install 消费者中存活。
- **在本地 vendored 或补丁 copy 修复。** 复制上游的并发 rename 逻辑等于手工实现已由受维护分发修复并评审过的文件系统层。
- **直接升到 pnpm 12。** 其 npm 包是包级 bin 加各平台 `@pnpm/exe.*` 二进制与安装脚本——这正是打包组件 note 要求走独立迁移评审的分发形态断裂，不属于本次修复。
- **停在 11.7.0。** 竞态将继续要求每个消费者自行规避，且被忽略构建契约在 11.28.4 上才与受维护的策略 API 对齐。
- **自行实现 depPath/选择器匹配。** `pnpm-workspace.yaml` 规则接受注册表名称、`name@version` 精确键与 git/file dep-path 键且语义不同；`@pnpm/building.policy` 拥有该评估，使批准不会因裸名称而放宽被拒绝的 file 来源构建。

## Testing

[`scripts/pnpm-runtime-component.spec.ts`](../../../../scripts/pnpm-runtime-component.spec.ts) 固化 pin、分发元数据、入口执行、迁址与 Wine 管线形态；[`packages/boot/plugin-manager/tests/build-approval.spec.ts`](../../../../packages/boot/plugin-manager/tests/build-approval.spec.ts) 覆盖策略契约，包括捕获、拒绝与畸形模块状态；`manager.spec.ts` 用真实固定版 pnpm 跑完被拦安装、批准与重试构建；[`apps/web/tests/plugin-install-approve.e2e.ts`](../../../../apps/web/tests/plugin-install-approve.e2e.ts) 端到端覆盖组装后的浏览器场景；[`scripts/client-tsconfig.spec.ts`](../../../../scripts/client-tsconfig.spec.ts) 通过编译器解析的项目输入断言，包括该场景在内的每个 Host 侧 web e2e 根文件都不会进入 client 程序。

## Consequences

hoisted 安装运行在已修复的 copy 代码上，不再需要亲和机制或 rename 重试；即使 pnpm 将该记录保存在模块状态而非工作区策略中，失败的插件安装仍能继续提供待批准的构建名称。本地验证覆盖 pin 契约、迁址 JS 入口、捕获/批准路径与脚本化管线；托管的 Wine 与各平台 lane 提供本机 Mac 无法提供的运行时证明。打包 pnpm note 保留其独立的主版本暂留与迁移清单；[dual Wine and native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.zh.md) 保留其 lane 拓扑；[current-profile plugin management](../architecture/2026-09-14-current-profile-plugin-management.zh.md) 继续负责批准 UX 与同意规则。
