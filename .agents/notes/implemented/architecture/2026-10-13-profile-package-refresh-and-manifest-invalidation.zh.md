# Agent Note: 包操作后刷新运行时解析，并使 HMR 包配置过期

Status: implemented

[English](2026-10-13-profile-package-refresh-and-manifest-invalidation.md) | 中文

## Problem

进程运行期间，Host 有两处状态不跟随变化：

- **运行时解析表只在启动时构造一次。** GUI 安装或启用后没有任何一方发布最新 generation，bundle 的私有依赖到不了 profile fallback，其裸插件名也找不到。停用或移除后，新一代无法移除 profile 作用域条目或 profile 本地包名，陈旧记录与包元数据继续存在。新安装的包目录是新的，Node 对它没有陈旧缓存；缺的只是表。
- **包配置与模块求值各自有缓存。** 清掉插件的模块缓存不会刷新 Node 用于 exports、main、imports 与格式判定的 package.json 字段。package.json 也可以作为 JSON 模块被 import，此时它的消费者需要普通模块重载。

上游提交 `869afc493df`、`abf8b760ecc`、`00b363074a2`、`bab69fbec59`（解析与管理器）与 `6fe4a2e184e`、`980b410340b`、`d7d2e5fd4ed`、`b1c5f861b66`、`a59beb8ae30`、`14e9bf61cb3`(HMR 失效）关闭了这两处；移植保留本地 `enforce`/`verify` 解析行为与 link 后端启动模式。

## Decision

### 职责划分

| 拥有方 | 做 | 不做 |
|---|---|---|
| 解析器（`app-boot/src/profile-resolution/resolver.ts`) | `replace()` 允许移除 `scope: profile` 条目与 profile 本地包名 | 触碰任何 Node 缓存 |
| plugin-manager | 在包操作的固定点调用 `pluginPackages.refresh()` | 构造解析表、管理模块与包配置缓存 |
| HMR(`packages/boot/hmr`) | 使包配置过期，并为作为 JSON 模块加载的清单保留普通重载 | 为纯配置清单重载插件；处理 `node_modules` 内包替换 |

### 运行时解析

包 identity 与 Worker 继承规则归 [generation Note](2026-09-09-profile-resolution-generations.zh.md)。

`replace()` 对新一代的校验：

- `scope: profile` 条目可以被移除。
- profile 本地包名可以被移除。
- 保留的 profile 条目维持规范化目录、版本与作用域，但在另一个选中 bundle 供出同一个包时可以换声明锚点。installation 映射与声明锚点不变。profile 作用域不可变；新的本地包名不能覆盖既有条目；已发布链接名不能改选另一个真实目录。

### Plugin Manager

| 操作 | 发布点 |
|---|---|
| 安装新包 | pnpm 成功且 bundle 选入已保存之后、reconciliation 之前，无论该 bundle 是否启用 |
| 覆盖已安装包 | 不发布；结果为 `restart-required` |
| 启用 bundle | 选入保存之后、reconciliation 之前 |
| 停用 bundle | 有 HMR 时，在 reconciliation 停止其插件之后；无 HMR 时不发布，运行中的插件保留当前表 |
| 移除 | pnpm remove 成功后，在 HMR 事务内 |
| 失败或取消的安装、失败的移除 | 不发布 |

`createRuntimeResolution()` 返回 `ProfileRuntimeResolution`，私有记录计算所用的 installation 锚点、Harness home 与 profile 目录。其 `computeLatestResolution()` 用相同输入重读该 profile，为最新 generation 返回新对象，原对象不变；Worker 只得到表字段。`PluginPackages.refresh()` 调用当前解析的 `computeLatestResolution()` 后 `replace()`;plain-data 构造的解析无法刷新，调用直接抛错。

无 HMR 时，取消选入一个启动 bundle 不会停止其插件。只要这种 bundle 仍处于未选中状态，后续包操作保留现有解析表而不发布其移除。其它非运行中 bundle 的无 HMR 安装与移除仍正常发布。profile 依赖与安装都没有持有的选中名（如退休 bundle)`removable`，其移除止于取消选入、不跑 pnpm。bundle manifest 读取失败会携带已经收集到的 version。

包操作成功后，后续发布被拒绝不回滚该操作。结果报告运行时应用失败，同时保留已成功的磁盘变更。重算使用记录的磁盘 profile 目录，不使用合成内存层；不带 profile 的合成解析只重算 installation 包。

### HMR 包配置失效

HMR 的变更派发中，`node_modules` 之外一个名为 `package.json` 的变更文件交给 `PackageManifests.invalidate()`。处在宿主依赖图中的清单仍请求宿主重载；作为 JSON 模块加载的清单仍重载其消费者。纯配置清单不调度模块重载。配置拥有的路径留在专属 watcher。同一批里的源文件变更在之后重载。

`invalidate(manifest)` 将该目录记为已过期。此后：

- 该目录下的 package.json 读取、scope 查询、type 查询与最近清单查询读取当前文件。消费者经由链接到达该包时，拥有关系跟随真实目录。
- 清空 ESM `ResolveCache`。其条目不记录每个被查阅的清单，且一个包条目可能解析到包目录之外。
- 同理清空 CommonJS `_pathCache`。无关请求重算解析而不卸载其模块。
- 使用默认解析器的 CommonJS 加载把新鲜解析出的文件名传给原生 loader。其私有请求别名不能选中旧条目；缓存的模块实例保持原样。

仅配置失效不改变已加载模块。Loader 条目在导出规范化之前把原始 import 结果保留为 `moduleNamespace`。HMR 将导入的 Node 模块对象与缓存的 ModuleJob namespace 匹配，重载已加载的 URL。所有匹配的 entry 记录（包括禁用的）只在重载成功后更新，失败时保持不变。停止并重启一个 Loader 条目会重新解析其包名并选中新条目。

entry 名按配置树 base URL 限定作用域，并保留全部互不相同的导入 namespace。未初始化的 entry 贡献名字但不抹掉已加载的 namespace；只有在无记录时才用名字解析，或用于 `cordis:` builtin。依赖分析考虑每个被记录的模块。共享插件运行时的 entry 使用一次替换操作，而每个 Loader 条目按其原始 namespace 选择替换对象。模块 import 与导出规范化完成后才移除旧运行时。失败的 import 或激活会恢复先前的模块与插件实现，并清理部分激活的替换品。

没有 Loader entry 的实例没有被记录的模块 identity。如果共享运行时的替换模块插件回调不同，HMR 报告歧义错误并回滚，而不是把该实例指派给某个任意模块。

包失效实现在 `packages/boot/hmr/src/package-manifest.ts`，由其封装 Node internal 接口。`index.ts` 派发清单变更并按模块 identity 定位已加载 entry。HMR 的 `node_modules` 排除规则不变。

| 接口 | 动作 |
|---|---|
| modules binding `readPackageJSON`、`getPackageScopeConfig`、`getPackageType` | 替换：已过期目录下的路径读取当前文件；其它调用走原生方法 |
| `package_json_reader.getNearestParentPackageJSON` | 替换：已过期目录绕过其 JS 缓存；无清单的查询返回原生缺失结果 |
| ESM Loader 的 `ResolveCache` 实例 | 原型 `get` 为一次查询被替换以获得该实例并立即还原；随后清空解析缓存 |
| CommonJS `Module._pathCache` | 清掉请求到文件名的缓存 |
| CommonJS `Module._load` | 默认解析器请求按解析后文件名加载；builtin 与已注册的 resolve hook 走原路径 |

binding 的 `getNearestParentPackageJSON` 只被 `package_json_reader` 调用，不替换。每个 HMR 实例拥有独立配置缓存。替换在首次过期时安装，在服务 dispose 时随 watcher 与重载队列清理一并还原。

## Alternatives considered

**现在移植 `RETIRED_BUNDLES`/`dropRetiredBundles`。** 对 CoHarness 否决：上游退休集合装的是 `dsh-experimental-schedule-bundle`，而本树仍把 schedule-bundle 作为可选 bundle 发布，退休集合会成为空死代码并使覆盖率门禁失败。`normalizeShippedProfile` 已重写那条退休的 installation 持有 tuple；待真实 bundle 退休时再采用按名机制。

**每次查询直接读磁盘。** 解析跟随磁盘，但模块缓存与运行中插件不重载。同 URL 内容不生效，不同 URL 会在一个进程内加载第二份版本。它还需要维护自己的 entry 解析器、绕过自定义裸名 hook，且不刷新运行时解析，GUI 安装的私有依赖仍找不到。

**在运行时解析发布时重读每个被观察清单。** 这把包配置失效放进了表发布，与模块缓存脱钩：覆盖已安装包报告需要重启，下一次无关发布却让新 import 加载新版本而旧插件仍在跑。包配置属于内容，应当与模块缓存同在 HMR。

**让 HMR 重载 `node_modules` 内的包。** 需要在包含 `node_modules` 的模块图上找受影响插件、避免共享库与 Cordis 的重复求值、处理缺失的 dynamic-import 边、模块副作用与 Worker。本次不做；这些场景继续要求重启。

**package.json 变更重载每个插件。** 纯配置清单不需要模块求值。实际作为 JSON 模块导入的清单保留普通依赖驱动重载。

**按包名重新 import 重载后的插件。** 能让 entry 改名跟随一次源码重载生效，但改变 `partialReload` 以已加载 URL 为重载单元的规则。entry 改名在 Loader 条目重启时已经生效，故不改动。

**每个 entry 名只保留一个 namespace。** 同名同 base URL 的 entry 在 manifest 变更前后可能加载了不同模块。只留首个或末个会丢失存活模块；未初始化 entry 不能抹掉别的 entry 导入的 namespace。

**无拦截层时让 refresh 抛错。** 上游没有 link 模式，`refreshPackages` 无条件调用 `refresh()`。本地 link 模式启动安装不带 resolution 的 `PluginPackages`，没有可重新发布的表；`PluginPackages.installed` 让管理器跳过该情形，而 `refresh()` 对 plain-data 解析仍抛错，保留真实缺陷的 fail-loud 契约。

## Consequences

- 有 HMR 时，支持的包操作发布更新后的私有依赖，并在插件停止后移除不再需要的映射。无 HMR 时，待生效的启动 bundle 停用把后续发布延迟到重启，保留运行中插件的映射。link 模式启动完全跳过发布，因为其物化 `node_modules` 已承载该变更。
- 在支持的线程内，package.json 配置读取使用更新后的字段；JSON 模块保留自己的重载行为。下述模块、loader 线程及 Worker 的独立限制仍然适用。
- 已过期目录下的包配置由 JS 解析 package.json，必须与原生读取保持字段和错误语义一致；测试与原生读取逐项比较。
- 实现依赖若干 Node internal 接口，Node 升级时需要重跑这些测试。

### Future Work

- `node_modules` 内在线替换、同路径重装、链接目标变更与跨包重载传播仍不支持。包更新需要进程重启；不保证每个管理结果都已正确报告该要求。
- 使用异步 loader 线程的 TSX 版本把该线程的包配置留在这些 hook 之外。同步它被延后；本次不提供通用 Worker 缓存同步。
- 已注册同步 resolve hook 的 CommonJS 私有请求缓存刷新被延后。这些请求保留原有 loader 行为。
- dispose HMR 还原原生读取器，其先前缓存的配置可能重新可见。跨 HMR 替换保留失效状态被延后。
- 上游 `RETIRED_BUNDLES`/`dropRetiredBundles` 按名退休 bundle 的移除机制延后到本树真实退休某个 bundle；`schedule-bundle` 在本树仍在发布。

## Verification

| 覆盖 | 位置 |
|---|---|
| 新一代移除 profile 条目与本地名，且仍拒绝保留条目变更、installation 声明锚点变更与链接重定向 | `packages/boot/app-boot/tests/profile-resolution.spec.ts` |
| GUI 安装、延后启用、停用、移除、覆盖、失败与取消，有无 HMR | `packages/boot/plugin-manager/tests/package-reload.spec.ts` |
| 按记录目录重算、合成 installation-only 刷新、plain-data 拒绝 | `packages/boot/app-boot/tests/profile-resolution.spec.ts`、`packages/boot/app-boot/tests/profile-resolution-service.spec.ts` |
| 连续无 HMR 操作、共享依赖声明锚点、磁盘成功/发布失败结果 | `packages/boot/plugin-manager/tests/package-reload.spec.ts` |
| exports、main、imports、type、scope 与最近清单失效；原生读取一致性；真实 CommonJS 加载与保留的模块实例；`node_modules` 边界；还原 | `packages/boot/hmr/tests/package-manifest.spec.ts` |
| 纯配置清单、JSON 模块与宿主重载、源码重载、同名与共享运行时 entry、import 与激活回滚、entry 重启、`node_modules` 排除 | `packages/boot/hmr/tests/package-manifest-dispatch.spec.ts` |

测试不需要 API key，不调用模型。

## Related

- [Profile 解析 generation](2026-09-09-profile-resolution-generations.zh.md)——包 identity、不可变范围与 Worker 继承。
- [Profile 解析查找顺序](2026-09-19-profile-resolution-lookup-order.zh.md)——本次刷新重新发布的优先级与作用域。
- [发布的可选 bundle](../process/2026-09-15-shipped-optional-bundles.zh.md)——`schedule-bundle` 为何在本树继续发布而非退休。
