# Agent Note：Profile 解析优先采用 ambient TypeScript 源码结果

Status: implemented

[English](2026-09-21-profile-resolution-ambient-source-plane.md) | 中文

## 问题

源码启动（`pnpm dsh`，即 `node --import tsx/esm`）会安装 `PluginPackages` 运行时解析，把 profile 作用域内的裸 specifier 路由到所选代次的 `packageDir`。路由后的查询锚定在 `node_modules` 内 declarer 的清单上，而 tsx 的 tsconfig-`paths` 钩子不会重映射 importer 位于 `node_modules` 下的导入，因此插件入口解析到了 `lib/index.js`。模块加载后 Node 会把模块 URL realpath 出 profiles 目录，于是插件自己的裸导入回落到 tsx `paths`、落到 `src/*.ts`。进程内由此同时运行每个 workspace 包的两份拷贝——插件入口在 artifact 平面，其依赖在 source 平面。

组合仍能启动，是因为 vendored Cordis 在两条路径上都经 `paths` 解析到 `src`，服务注册表保持单一。首个致命断点是 `TOOL_RUNTIME_SCHEDULER`：`ctx.tools` 携带 `lib` 拷贝的符号，而 `agent-loop` 用 `src` 拷贝的符号比较，导致每次工具调用都以 `UNKNOWN: Cannot read properties of undefined (reading 'prepare')` 结束 turn。任何跨包拷贝的 `unique symbol` 或 `instanceof` 契约都会以同样方式分裂。

## 决策

`installProfileResolution` 现在在 enforce/verify 路由之前先探测 ambient 解析。`ambientSourceResult` 通过原生 loader 从原始 parent 重新解析请求，仅当结果落在 TypeScript 产物（`ts`/`tsx`/`mts`/`cts`）上才保留。命中 source 平面的 ambient 结果优先于路由出的 artifact 条目，因此源码启动让插件入口与其依赖保持在同一平面；纯 artifact 启动的 ambient 结果是 `.js`，路由行为与之前完全一致。enforce 与 verify 语义不变——探测在两者之前，仅在命中源码时提前返回。

`TOOL_RUNTIME_SCHEDULER` 额外改用 `Symbol.for`，恢复了被 alpha.2 合并回退为 `Symbol()` 的[进程稳定符号决策](2026-09-18-tool-scheduler-process-stable-symbol.zh.md)：全局注册表让该协议槽对任何残留的拷贝分裂保持稳定，而本探测则消除了 profile 启动下的分裂本身。

## 已考虑的替代方案

**无条件把入口路由到 source 平面。** 否决：tsx `paths` 是源码启动的细节；在已构建的安装下 ambient 解析得到 `lib`，硬路由到 `src` 会破坏 artifact 平面启动。

**把 Loader 的内部 `import()` 统一到 ambient 钩子链。** 已在[进程稳定符号笔记](2026-09-18-tool-scheduler-process-stable-symbol.zh.md)中否决：vendored Loader 手术超出缺陷范围，且上游以同样方式挂载条目——这是一个上游同样潜伏的隐患。

**只依赖 `Symbol.for`。** 否决：它只免疫一个协议槽，其余按模块身份（`instanceof`、私有 `Symbol()` 键、重复的模块状态）仍会跨拷贝分裂；组合进程根本不应混合平面。

## 影响

- 在有已构建 `lib/` 的树上，`pnpm dsh --profile headless` 能完整跑通工具往返；此前每次 `pnpm build` 后首个工具调用必崩。
- ambient miss（profile 父级不可解析的名字，或 ambient 结果为 `.js`）回落到既有 enforce/verify 路径不变，artifact 安装保留代次路由及其诊断。
- 探测为每个未缓存的作用域请求增加一次原生 `resolveSync`；解析出的源码结果与路由结果一样缓存进 `state.esm`。
- 由 `apps/cli/tests/profiles/headless/tests/source-launch.spec.ts` 验证——它经 tsx 启动真实 `bin.ts`、通过 `PluginPackages` 加载发布的 headless profile 并完成一次工具调用（对修复前实现会失败）；另有 `packages/boot/app-boot` 的 profile-resolution spec（63 个测试）覆盖 ambient 源码命中、非源码与带属性分支。
