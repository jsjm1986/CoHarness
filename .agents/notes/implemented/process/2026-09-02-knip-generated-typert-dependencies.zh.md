# Agent Note：Knip 正确识别生成的 Typert 运行时依赖

Status: implemented

[English](2026-09-02-knip-generated-typert-dependencies.md) | 中文

## 问题

Typert 生成发生在 Host 构建期间，并产出不经打包的 `lib/typert.host.js` 与 `lib/typert.remote-client.js` 文件。这些生成文件会直接导入 `zod`，但源码没有理由仅为了让 Knip 观察到依赖而重复同一导入。

`dsh-file-reference`、`dsh-session-reference`、`dsh-cordis-host-runner` 与 `dsh-commands` 都发布由这些生成文件承载的 `./typert` 和 `./remote` 出口。被 Git 忽略的 `lib` 产物存在时，Knip 会沿 package exports 读取它们，因此已构建过的 checkout 能直接观察到 `zod` 导入；干净 checkout 没有这些生成 JavaScript，便会把同一项必需依赖报告为未使用。静态 `ignoreDependencies` 无法同时覆盖两种状态，因为产物存在后 Knip 会把该配置判为冗余提示。若从 manifest 中删除这些条目，发布后的子路径会在 pnpm 严格依赖布局下加载失败。

## 决策

`knip.config.ts` 包装已检入的 `knip.json` 基础配置。对于每个受影响的 workspace，只有当两份生成 JavaScript 契约面都不存在时，它才注入 workspace 级 `zod` 例外；只要任一生成契约面存在，包装层就保持该 workspace 不变，由 Knip 通过 package export 直接观察裸导入。包 manifest 继续把 `zod` 保留为运行时依赖，因为发布的生成 JavaScript 会导入它。

例外只覆盖这四个包：从源码导入 `zod` 的其他包继续接受正常检查，Knip 不获得仓库级豁免。各包 README 会在持久维护约束旁记录这项生成文件依赖。源码不会为了满足分析器而添加空导入；配置会如实描述源码平面与产物平面的差异。

## 验证

四个包的 Host 构建产物都在两份生成 Typert 文件中包含裸 `zod` 导入。`scripts/knip-config.spec.ts` 在不修改基础 JSON 的情况下覆盖干净 checkout 与已构建 checkout 两种解析路径。无论生成文件存在，还是临时移除受影响的生成 JavaScript 契约面，`pnpm run knip` 都会通过；常规构建与包检查则继续验证发布出口能够解析其已声明的运行时依赖。

## 考虑过的替代方案

**从四个 manifest 中删除 `zod`。** 不采用，因为生成的 `./typert` 与 `./remote` JavaScript 会在运行时导入它。

**向源码文件添加空的类型导入。** 不采用，因为这会错误表示源码所有权，并让生产代码耦合到单个分析器的局限。

**在 `knip.json` 中保留静态 workspace 例外。** 不采用，因为已构建 checkout 会使这些条目变成冗余配置提示，而仓库会把 Knip 提示视为错误。

**在全仓库忽略 `zod`。** 不采用，因为其他包由源码拥有的使用仍应接受验证，陈旧依赖也应继续可以被发现。

## 后果

Knip 对普通源码依赖继续保持严格，同时在干净和已构建 checkout 中都能接受这四项生成运行时依赖。以后若新增带生成 Typert 出口的包，除非其源码本身已经导入 `zod`，否则既需要真实的 `zod` 运行时依赖，也需要加入生成契约面包装层。
