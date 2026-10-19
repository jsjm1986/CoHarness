# Agent Note: 独立 Gateway CI 通道中的工作区源码解析

Status: implemented

[English](2026-09-15-standalone-gateway-lane-source-resolution.md) | 中文

## 问题

`gateway` 与 `gateway-admin-ui` 这两个拉取请求通道只用 `npm ci` 安装 `gateway/package-lock.json` 与 `gateway/admin-ui/package-lock.json`；根 pnpm 安装与工作区产出的 `lib/types` 在这些通道里并不存在。Gateway 源码仍直接从 `src` 导入工作区包，admin 界面也重导出工作区组件源码，因此通道必须在缺少仓库自身安装与构建面的情况下解析这些导入。

## 决策

每个解析边界取恰好能产出该通道所需制品的最小面。

`gateway/tsconfig.json` 只为能在 Gateway 严格编译选项下编译的工作区源码通过 `paths` 映射 `@deepseek-ai/*` 说明符。源码无法在其下编译的模块——vendored Cordis 在自有宽松 tsconfig 下构建，Typert protocol 同样保持独立的检查面——在 `gateway/src/workspace-modules.d.ts` 中一次性声明为 ambient 合并目标，使触达源码中的模块增补仍能完成类型检查，而生产构建继续通过 node_modules 解析真实的产出声明。

`gateway/tsconfig.ci.json` 沿用同一组 `paths`，把完整触达源码图发射到临时 `lib-ci` 目录。通道以 `npm run build:check` 运行它，取代通过各包产出 `lib/types` 解析工作区包、在独立检出中无法成功的生产 `npm run build`。

`paths` 映射还把若干工作区说明符指向产出的 `lib/types`——源码需要自有编译选项的 vendored 包、持久化索引签名需要 `exactOptionalPropertyTypes` 的 `session-format`，以及用户文档包 `userdoc`、`userdoc-local`、`host/userdoc-http`——因此通道在类型检查前先发射这些声明。该发射是通道唯一的工作区安装例外：`userdoc-http` 的项目引用拉入一张覆盖宿主全图的闭包，其中的第三方导入与 TypeScript 6 语法无法临时供给，所以该步骤运行 `pnpm install --frozen-lockfile --ignore-scripts` 并使用仓库自身的 `node_modules/.bin/tsc -b`。Gateway 自身的 typecheck、build:check 与测试仍运行在独立的 npm 安装上。

`plugins/dsh-directory-guard/tsconfig.ci.json` 仅转译发射策略包（`noCheck`、不带 ambient `types`），因为 Gateway 测试只把 `package.json` 与 `lib/` 物化到预置实例主目录中，从不执行该插件；类型保真度仍归工作区构建完成后的基础配置。该步骤运行 Gateway 自身安装的 `tsc`，因此它共享通道的 npm 安装而非工作区安装。

`loadConfig` 的源码运行默认值把 `tsx/esm` 解析为仓库根下的绝对路径（实例在其外孵化）；供声明发射使用的工作区安装已直接提供该开发依赖。admin UI 通道仍以临时前缀方式安装被重导出的工作区源码所导入的第三方包（`anser`、`clsx`、`immer`、`zustand`，版本读自其属主清单）。在 `gateway/admin-ui/vite.config.ts` 内，`server.deps.inline` 让 `zustand` 留在 Vite 管线中：被外置的副本会在 `dedupe` 映射之外解析它的 `react` 导入，从而加载第二个 React 实例。

## 已考虑的替代方案

把根 `pnpm install` 加过滤式工作区构建作为通道通用策略的方案被否决：它会把秒级的独立通道拖成数分钟的工作区构建，并重新把 Gateway 检查耦合进这些通道本来要回避的完整仓库工具链。声明发射是该否决唯一不成立的部位——其项目引用闭包触达仅在真实安装下才能解析第三方导入的包——所以供给只圈定在该步骤内。在 Gateway 严格编译选项下编译 vendored 与 Typert 源码的方案被否决，因为这些包按设计拥有各自的宽松检查面。在通道中运行插件真实 `tsconfig.build.json` 的方案同样被否决，原因与其 `lib/types` 路径在该处不可能存在相同。

## 后果

- 独立通道在 Gateway 自身的编译与测试面上忠实地复现干净的 `npm ci` 检出：每个工作区导入要么从源码编译，要么被显式声明为 ambient；触达图所需的每个运行时依赖都供给在仓库根。
- `lib/types` 声明发射不属于该复现：它运行在真实的不可变工作区安装内，因此 paths 映射声明为产出输出的包，其项目引用可以深达宿主图所及之处。
- 向 Gateway 代码新增工作区源码导入时，要么在既有 `paths` 下编译通过，要么需要一次刻意的 ambient 声明；不可能经由某个已安装的传递副本静默蒙混。
- ambient 声明只覆盖触达源码实际合并的目标。把它放宽成伪造的完整包会掩盖真实的解析失败，因此新需求应扩充该文件而不是绕过它。

## 验证

- `pnpm install --frozen-lockfile --ignore-scripts` 之后，对发射清单（vendored 包、session-format 及其 catalog、managed-data、atomic-write、llm、userdoc、userdoc-local、userdoc-http）执行 `node_modules/.bin/tsc -b` 退出码为 0。
- 在同一棵树上以通道自身的 npm 安装运行，`npm run typecheck --prefix gateway` 与 `npm run build:check --prefix gateway` 通过。
- `gateway/node_modules/.bin/tsc -p plugins/dsh-directory-guard/tsconfig.ci.json` 发射 `lib/` 且退出码为 0。
- 在同一棵树上，发射 directory-guard 与 steward-tools 包之后 `npm test --prefix gateway` 通过（`tsx` 从工作区安装解析）。
- 供给四个仓库根级依赖之后，`npm test --prefix gateway/admin-ui` 与 `npm run build --prefix gateway/admin-ui` 通过。
