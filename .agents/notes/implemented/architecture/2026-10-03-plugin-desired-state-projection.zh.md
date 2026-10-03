# Agent Note: PostgreSQL 期望插件状态投影进运行时 profile，实例回发观测到的组成

Status: implemented

[English](2026-10-03-plugin-desired-state-projection.md) | 中文

## Problem

`dshHome/profiles/web` 下的 profile 文件曾是插件组成的唯一真值源。Admin 插件页只能在目标实例持有活的 generation 租约时编辑，管理员无法为停止的用户或项目预备组成，重建的 `dshHome` 会静默丢失此前所有选择。运行时变更也从不进入数据库，Admin 看到的组成与实例实际应用的结果逐渐漂移。另一方面，管理授权同时门控读取与写入，未授权用户只能看到空白页，尽管清单可见性从来不是特权部分。

## Decision

- 迁移 [`049_plugin_states.sql`](../../../../gateway/deploy/postgres/migrations/049_plugin_states.sql) 新增 `harness.plugin_states`——每个 `(organization, user|project)` owner 一行期望状态，保存逐字 patch `entries`、有序 `bundles` 选择与 CAS `revision`。行不存在表示无期望状态、不做投影；已有的 `instances.applied_policy_revision` 列记录 spawn 投影到的 revision。
- [`gateway/src/plugin-state.ts`](../../../../gateway/src/plugin-state.ts) 拥有该契约：`get`/`save` 以带 revision 护栏的写入服务 admin 编辑器，`publish` 在 base-revision CAS 下接受运行时回写、base 过期时应答 409，`project` 把行物化进 profile 文件，`observed` 为 Admin 在线视图读取文件，`markApplied` 标记已投影的 revision。
- Spawn 投影在 `proxy.beforeStart` 内 `mountPolicyBundles` 之后运行：比 `applied_policy_revision` 新的行重写 `profiles/web/cordis.patch.yml` 中的管理形态行（键集限于 `{id, name, disabled}`）与 `package.json` 的 `dsh.profile.bundles`，不动 dependencies。无法解析的 bundle 名告警并跳过而非阻断启动，因为数据库可能持有过期的安装引用。
- [`PluginManagerService.change()`](../../../../packages/boot/plugin-manager/src/index.ts) 在 profile 文件落盘后通过 `pluginManagementAuthorization.reportState` 回发已提交的组成。409 经 `fetchState` 拉取更新的期望行并就地调和进 profile 与 HMR，运行中的实例无需重启即收敛到管理员的编辑。回发失败保留已提交文件并在 `warnings` 中报告；下一次 spawn 重新投影存储的 revision。没有授权服务的 standalone profile 跳过回写，保持上游行为。
- 授权拆分为读/写：`authorize('read')` 无条件放行，`listPlugins`、`listBundles`、`listVersionExemptions`、`registries`、`waitForInstall` 与 `access` 保持开放，而 `inspect` 与每个变更都过 `authorize('manage')`。新的 `access` remote 应答 `{manage}`，用户页、设置清单页签与 API 代理据此直接门控控件；`plugin_access_policies` 语义从读+写收窄为写授权。
- Admin 插件页新增期望状态编辑器（`DesiredStateEditor`）：对任意目标——运行中或停止——加载 `GET /admin/api/plugins/state`，离线编辑 bundle 选择与条目启停，经 `POST` 携带 revision 保存；409 重新加载更新的状态而非覆盖。用户插件页为所有查看者保留完整清单可见，当 `access` 报告 `manage: false` 时降级为只读模式。
- 两处投影——gateway spawn 与运行时回写/调和——共享同一条管理行规则（仅 `{id, name?, disabled:boolean}` 键），两端各自实现，`desired-state.ts` 测试与 `plugin-state.spec.ts` 在两端钉住文件协议。

## Alternatives considered

- **文件为真值、数据库为镜像。** 镜像方案仍无法离线编辑，且在 `dshHome` 重建后同样丢状态；数据库必须成为期望状态的权威，文件是其运行时投影。
- **管理员写入时投影。** 管理员保存时写文件会让停止实例的活树与其将来的 spawn 物化不一致，也无法在 `dshHome` 重建后存活；spawn 时投影是唯一能看到最终文件树的时点。
- **把安装集合记入期望状态。** Bundle 条目引用 profile 文件系统上的 npm 包；数据库行无法在 home 重建后重新安装它们。期望状态只记录选择与启停，spawn 对无法解析的 bundle 告警跳过。
- **项目实例的按成员期望行。** 项目运行时为所有成员组合一棵共享树，按成员启停没有可落脚的实例；项目行即共享期望状态。

## Consequences

管理员可为停止的目标预备组成并在下一次 spawn 生效；运行中的实例仍通过 invoke 路径即时应用编辑，并经回写 CAS 收敛到更新的期望行。用户无授权时保留清单可见性，获得清晰的只读界面而非失效控件。冲突以后到的管理员写入为准：运行中实例的 409 路径将其文件收敛到存储的行，失败的回发在下一次 spawn 自愈。该契约由真实 PostgreSQL 上的 `plugin-state.spec.ts`（投影、CAS、observed 读取）、`desired-state.ts` 文件协议测试、runtime-api 端点测试、`DesiredStateEditor` 组件测试与只读 store/组件 specs 钉住。安装规格与按用户配置值仍是文件平面问题，不在本层范围内。
