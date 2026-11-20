# Agent Note：Preset 挂载审计等待行收敛并上报失败 fiber

Status: implemented

[English](2026-09-21-preset-mount-audit-failed-rows.md) | 中文

## 问题

`mountPreset` 的激活审计（`inactiveRows`）只报告两种不可用状态：没有 fiber 的行（"never started"，导入失败）和 fiber 缺少必需服务的行（"waiting for X"）。第三种状态穿了过去：config 校验或 `apply` 抛错的行会把 fiber 收敛进 `FiberState.FAILED`——fiber 存在、声明的 inject 也能解析，于是审计放行，挂载带着一条静默死行成功。

这个盲区并非理论问题。早前一次改名把 `dsh-persona` 的 config 字段从 `text` 改为必填的 `prefix`，但出厂的 `minimal` 与 `cordis` preset 里留下了 `text:`。两个 persona 行在此后数周的每次挂载都校验失败；`minimal` preset 实际跑的是完整部署提示词而非其固定 persona（`complete: true` 与 `includeRuntimeContext: false` 从未生效），`cordis` preset 静默丢失了自指 persona。直到一个 Web 快照测试发现 `includeRuntimeContext: false` 本应抑制的 runtime-context `user/message` 出现，才有人察觉。

## 决策

`inactiveRows` 与 `auditRows` 在检查 inject 前先对每个 enabled 行的 `fiber.await()` 等待收敛。`await()` 排空 fiber 的在途激活并重抛其记录的失败，于是收敛失败的行以 `id (name): <error>` 的形式进入挂载拒绝信息，不再被放行。pending 在缺失 inject 上的行没有在途工作，会立即返回。

文件挂载用 `auditRows` 区分失败行与等待 Host 依赖的行。存在 pending 依赖时，等待一次 Host Loader 收敛，再审计子树，与声明式 preset 的诊断保持一致。Loader 收敛等待在途初始化，不会无限等待一个不存在的服务。运行时调用方在 Host 条目激活之外通过 Agent setup 挂载；standing preset 子树不属于 Host 条目清单，因此等待不会包含自身挂载。审计与发布前，所属 scope 和子树都必须仍然存活：因释放而清空的 Include 不能被视为可用组合。真正缺失的服务与失败行仍携带详情拒绝。取消 Agent 创建会回滚尚未发布的 Agent，而不中断共享的 Host 初始化；standing 资源仍由 registry 持有，并随所属者释放。

两个出厂 preset 的 persona 行改用 `prefix:`，恢复了 `minimal` 的完整提示词/runtime-context 抑制契约与 `cordis` preset 的 persona。

## 备选方案

**同步检查 `fiber.state === FiberState.FAILED`。** 否决：行 fiber 异步激活，审计时刻一个注定失败的行可能还在 `LOADING`；同步读取会错过一个微任务后才落地的失败。等待收敛是无竞态读取失败状态的唯一方式。

**保持审计原样、只修过期字段。** 否决：过期字段之所以能存活数月，正因为没有任何东西观察死行。未来任何一次 config schema 改名都会重新引入同样的静默失败；[激活审计决策](../architecture/2026-09-17-loader-activation-audit-consumers.zh.md) 已经确立了规则——消费方必须审计 entry 状态，因为 `loader.await()` 不再意味着激活。

**在 `dsh-persona` 里恢复 `text` 别名。** 否决：该字段是上游有意改名；保留别名等于为一个值维护第二个名字，而现存消费方只有那两个过期文件本身。

## 影响

- config 或 `apply` 失败的 preset 行现在会以行 id、specifier 和校验详情拒绝整个挂载——与审计对导入失败既有的"点名每一行"契约一致。
- `inactiveRows` 返回 `Promise<string[]>`；`auditRows` 为挂载与声明式 preset 诊断分别报告 failed 和 pending 行。
- `cordis` preset 的系统提示词变为其编写的 persona 文本（此前静默渲染的是部署默认值）；没有快照钉住那套死行为。
- 新增 fixture 覆盖：`bad-config` preset 与 `rejects-config` 插件在 `mount.spec.ts` 中钉住收敛检查（48 个测试）。
- 真实 Loader 冷 Host 组装覆盖首次创建、缺失及失败的 provider、取消、Host 仍 pending 时仅卸载 registry，以及所属者清理。headless cold-preset 场景检查首次模型请求与恰好一次的持久回复。
