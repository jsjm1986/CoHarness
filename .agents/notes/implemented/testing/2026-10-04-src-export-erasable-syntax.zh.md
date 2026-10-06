# Agent Note: `./src/*` 导出必须只含可擦除 TypeScript

Status: implemented

[English](2026-10-04-src-export-erasable-syntax.md) | 中文

## Problem

`DSH_EXAMPLE_MODE=lib`——`ci-snapshot` 所选模式——以 plain Node 启动示例 bin。这些组合中的 `.mjs` 夹具通过已发布的 `./src/*` 导出导入包内部模块，该导出解析到原始 `.ts` 源码并由 Node 内建类型剥离加载。strip-only 模式只接受可擦除语法：`import type`、`as`、类型标注与裸访问修饰符字段会被移除，而参数属性、枚举与命名空间需要真实转换，在解析期即失败。`headless-agent` 的外部夹具报出 `TypeScript parameter property is not supported in strip-only mode`，Loader 只上抛 `failed to import`（[`vendor/loader/src/config/entry.ts`](../../../../vendor/loader/src/config/entry.ts) 通过 `ctx.logger` 记录真实错误，但 smoke 不转显），组合运行最终以 `NO_ADAPTER` 收场。

## Decision

两条不变量，落在被破坏的包中：

- **`./src/*` 下只写可擦除语法。** 经已发布 `./src/*` 导出可达的 `.ts` 文件必须能在 strip-only 模式下解析。`subagent-codex` 的 `member.ts`、`run.ts`、`wire.ts` 与 `subagent-acp` 的 `index.ts`、`member.ts` 将构造函数参数属性改为显式字段声明加赋值；`model?: string` 改为 `model: string | undefined`，因为 `exactOptionalPropertyTypes` 不允许向可选属性写入 `undefined`。行为不变。
- **源文件中的裸说明符在 lib 模式下走真实包解析。** `subagent-acp/src/run.ts` 导入了 `@deepseek-ai/dsh-brand`，但包清单未声明它；tsconfig `paths` 在 `src` 模式下掩盖了这一点，而 lib 模式应用 pnpm 的真实依赖闭包。现按兄弟包惯例在 `peerDependencies` 与 `devDependencies` 中以 `workspace:*` 声明 `dsh-brand`。

## Alternatives considered

- **从包根再导出 member 类。** 为了让夹具可以继承内部实现而新增公共表面；已否决——`./src/*` 旁路的存在正是为了让夹具触达内部而不扩大 API。
- **让夹具改为导入 `lib/` 产物。** `tsdown` 把 `member.ts` 并入 `lib/index.js`，没有可指名的 `lib/member.js`，而且依赖打包形状比源码语法更脆弱。
- **把 Loader 的导入错误透进 `failed to import`。** 诊断在 `ctx.logger` 中已存在；把它接入 smoke 的 stderr 本可省去一小时的排查，但这是独立工作，并非本次修复的前提。

## Consequences

凡置于 `./src/*` 导出下的新 `.ts` 源码都受此可擦除约束；同一失败模式也会因该可达类中的 `enum`、`namespace` 或装饰器而重现。`test:coverage` 与包级 spec 走 `src` 面，无法发现它——只有 `lib` 模式的 Loader smoke 才能检出。

## Related

- [`dsh-loader-smoke`](../../../../packages/test-support/loader-smoke/src/index.ts) 的 `resolveExampleLaunch` 契约记录了 `src`/`lib` 启动分流。
