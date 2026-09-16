# Agent Note: 上游 sovereignty 清单与同步门禁

Status: implemented

[English](2026-09-12-upstream-sovereignty-manifest.md) | 中文

## 问题

本 fork 与上游 `deepseek-harness` 没有共享 git 历史：迄今每一次上游集成都是按能力面选择性移植，而不是合并。哪些 `packages/<group>/<pkg>` 目录逐字节跟踪上游、哪些携带自有改动、哪些是 fork 独有、哪些上游发布而 fork 未携带，只记录在散文式升级计划和一次性对齐矩阵中。这些记录会悄悄过期，不重新分析就无法回答“采用 tag X 会动到什么”，也给 CI 留不下可强制检查的东西。

## 决策

逐包 sovereignty 现在记录在有版本的清单 `scripts/upstream-sync.json` 中，以 `<group>/<pkg>` 为键。每个已携带的包是 `tracked`（其 `src/` 与所同步上游 commit 完全一致）、`adapted`（上游存在但其 `src/` 带自有改动）、`replaced`（上游存在但 fork 整体持有契约，上游 diff 永远无法按文件合并落地，必须逐行为移植）或 `owned`（无上游对应）；上游发布而 fork 未携带的目录列入 `upstreamOnly`。`replaced` 条目必须指名记录替代方案的 `note` 文件；`adapted` 与 `replaced` 条目可声明 `removedUpstreamPaths`——在同步 commit 存在、在磁盘被刻意移除的仓库相对路径，门禁双向验证。`upstreamOnly` 条目是 `{ package, reason, replacedBy? }` 对象，使“未携带”无法与“尚未审查”混淆。记录的 baseline 是 `dsh-v0.1.5-rc.2`（commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`）。

`pnpm run verify-upstream-sovereignty` 在 `ciStaticGates` 内对该清单设卡，即 `upstream-sovereignty` gate：它用 `git diff --quiet <syncedCommit> HEAD -- packages/<key>/src` 重查每条 `tracked` 声明，并强制 manifest↔磁盘↔tag 双射，包括任何 `owned` 包不得存在于所同步 tag、任何 `upstreamOnly` 条目不得存在于磁盘。`pnpm run upstream-sync:report -- --tag <next>` 按 sovereignty 分桶打印指向更新 tag 的 Markdown 增量——`tracked` 条目即需逐文件调和的冲突——因此采用下一个 baseline 从算出的清单开始，而不是手工搭建矩阵。`--residue <olderTag>` 额外列出 `adapted`/`replaced` 包下仍与更老上游 tag 逐字节相同、而上游在同步 commit 之前已改动的文件（`stale`），并与上游新增但从未携带的文件（`unadopted`）分开——这是 sovereignty 分类本身无法表达的低于 baseline 残留的机械探测器。`windows-native` 与 `serial-windows` 的 checkout 拉取完整历史（`fetch-depth: 0`），因为 depth-1 克隆不带可供门禁解析的 tag。

## Alternatives considered

**继续用逐升级的对齐矩阵。** 不采用：每个矩阵在撰写时冻结一次比较；清单是一份持续记录，门禁每次运行都对照工作树与镜像 tag 重新验证。

**把 sovereignty 记进 package.json 字段或 README 散文。** 不采用：分类必须对照 git 状态做一趟扫描；集中清单让双射检查（manifest 对磁盘对 tag）成为单趟计算。

**以最新落地的 tag（`dsh-v0.1.5-alpha.1`）为 baseline。** 不采用：已落地不等于已验证——门禁的 `tracked` 集合只有对照本地 `src/` 状态真正调和过的 commit 才有意义，即 [alpha.2 同步记录](../architecture/2026-09-08-upstream-alpha2-selective-sync.zh.md) 所载的 alpha.2 同步。

## Testing

`pnpm exec vitest run scripts/verify-upstream-sovereignty.spec.ts scripts/sync-upstream-report.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts` 覆盖清单校验、磁盘/tag 双射、`tracked` 零差异重查、`replaced` 缺 note 拒绝、`removedUpstreamPaths` 逃逸与复活拒绝、`upstreamOnly` 的 reason 与 `replacedBy` 校验、报告分桶与 `--from`/`--tag`/`--residue` 解析、门禁在 `ci-static` 与 `ci-windows-observational` 聚合中的成员关系，以及两个 Windows checkout 的 `fetch-depth: 0`。`pnpm run verify-upstream-sovereignty` 报告 3 tracked、227 adapted、2 replaced（`api/gateway`、`session/session-persistence`）、25 owned、35 upstream-only，对照 `dsh-v0.1.5-rc.2`。

## Consequences

sovereignty 成为机械事实而非散文：`src/` 漂移却仍声称 `tracked` 的包会让门禁失败；采纳上游清单内包而不归类也会让双射失败。恢复某个被移除上游文件的包必须在同一 PR 删除其 `removedUpstreamPaths` 行。未抓取镜像 tag 的克隆无法运行依赖 git 的检查；spec 在那里跳过而门禁本身响亮失败。重新定 baseline 即更新 `syncedTag`/`syncedCommit`/`upstreamOnly` 并按重算结果翻转 sovereignty，由 `upstream-sync:report` 的增量驱动；`--residue` 输出即清扫冻结在所声明 baseline 之下的文件的工作清单。
