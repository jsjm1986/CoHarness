# Agent Note：HMR 对账重新派生启动器补丁

Status: implemented

[English](2026-09-20-hmr-reconcile-drops-launcher-derived-patches.md) | 中文

## 问题

`dsh web` 启动时由 `runProfile` 计算 `resolveShippedPresetPatch` 启动器补丁，把内置 preset 根目录前置进 `agent-presets` 的 `config.roots`。但每次启动数秒后花名册就被静默清空（会话恢复报 `preset "ptc" not found (available: none)`）：HMR 配置 watcher 在启动时对已存在文件触发 `add` 事件（`ignoreInitial: false`），其 refresh 只经 `readProfilePatches` 重读磁盘上的补丁层，再由 `reconcileProfilePatches` 用这份清单整体替换根 Include 的 `patches` 数组。重组装后的 `agent-presets` 条目缺失启动器补丁，`entry.update` 以 `config.roots` 回退到 schema 默认 `[]` 重载了 fiber。

## 决策

`ProfileContext` 新增 `derivePatches` 回调，`readProfilePatches` 对每次新鲜组装的行集合调用它并把结果追加进返回的补丁代。`runProfile` 用 `resolveShippedPresetPatch` 实现它，使启动、HMR 对账及任何后续重读都基于实际在应用的行集派生内置根补丁——即[花名册笔记](../architecture/2026-08-29-derived-shipped-preset-root.zh.md)既定的按代派生，如今在补丁读取处落实而非首个消费处。按次派生——而非存储已解析补丁——避免了启动时快照覆盖用户事后对同一行（`default`、追加 `roots`）的 `cordis.patch.yml` 编辑。

## 备选方案

**把已解析补丁一次性推进 `context.overlays`。** 否决：存储的补丁内嵌启动时刻的行配置；HMR 重放会回退用户在启动后对 `agent-presets` 的 `default` 或 `roots` 所做的修改。

**把补丁持久化写入 profile 的 `cordis.patch.yml`。** 否决：该文件归用户所有；写入启动器内部状态会把部署状态与用户编辑耦合，还会在每次检出路径变化时重复内置根。

## 影响

任何启动器派生补丁都必须经 `derivePatches` 才能存活过 HMR 对账——`reconcileProfilePatches` 把返回清单当作完整补丁集，对 `readProfilePatches` 不可见的层会在启动后首个配置文件事件时被丢弃。telemetry 补丁本就以在 `readProfilePatches` 内重算的方式遵循此规则；`derivePatches` 把同一保证扩展到应用侧计算的补丁。

## 测试

`dsh web --profile web` 启动时 `config.roots = [内置, 用户]`，且花名册在启动期 HMR 扫描后保持填充——发送消息正常恢复会话，不再报 `available: none`。派生逻辑本身由 `apps/cli/tests/shipped-preset-root.spec.ts` 覆盖。
