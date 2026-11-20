# Agent Note: 按 diff 触发的 Android 构建门禁

Status: implemented

[English](2026-11-19-android-build-pr-gate.md) | 中文

## 问题

`android-build` job 此前只能通过手动 `android-audit` workflow_dispatch 套件触发,因此改动 `apps/android-shell/` 或其注册消费方输入的 PR 在没有任何编译检查的情况下就能合并。这个缺口让 UnifiedPush 变更里的重复 `jpushConsentGranted` 方法合入 `master` 并使之后所有检出的 `assembleDebug` 全部失败——必经路径上没有任何环节能拦住它。

## 决策

`androidMode` 现在是真实的消费方 mode(`'skip' | 'full'`),与 Gateway 和 Admin UI lane 使用同一套输入规则:`apps/android-shell/**` 变更以及命中已注册 `android` 消费关系的路径选择 `full`。`android-build` 加入 `pr-scope` 的 needs,在 PR 上按 scope 选择结果触发(`workflow_dispatch` 的 `android-audit` 套件仍然可用),并加入 `all-checks-passed` 的 needs 集合,使 `verify-pr-results` 在计划选中时要求其证据。scope 通过 `validation_plan.scope.androidMode` 传递该 mode,经由新增的 `scopeJobs` 条目进入 `requiredPrJobs`。

依赖模拟器的 `android-bridge` job 保持仅手动:托管 KVM 运行对于必需的 diff 门禁来说太慢且太脆弱,而 `pnpm run check:android` 内的 debug 构建、lint、单测以及插桩 androidTest APK 编译已经覆盖了实际漏过的失败类别。

## 备选方案

**保持 Android 仅手动、出问题再修。** 否决——重复方法的破坏证明这条路会静默失败:破坏一直留在 `master` 上直到一次发布构建才发现,而每次反应式修复都要单独走一个 PR,期间所有检出都是坏的。

**连模拟器 bridge 也设为必需。** 暂不采纳——依赖 KVM 的插桩测试是该 lane 最易抖的半边,会给必经路径增加数十分钟;仅构建 job 就能捕获编译、lint 和单测级回归,观测到的破坏正发生在这一层。

**对所有 diff 无条件开门。** 否决——Android SDK + Gradle lane 对根本触及不到壳的 PR 也要花数分钟并占用一台 runner;按 diff 触发的消费方模型正是为这种取舍设计的。

## 验证

`classifyCiPrScope` 对 `apps/android-shell/**` 与消费规则路径(如 `apps/web/src/native-push.ts`)返回 `androidMode: 'full'`,对无关或 inert 路径返回 `'skip'`,对空/未知 diff 兜底返回 `'full'`;`ci-consumer-relations.spec.ts` 固定两个方向。`requiredPrJobs` 把 `androidMode: 'full'` 映射到 `android-build` job,`verify-pr-results.spec.ts` 在全消费方集合中要求它。`gate-workflow-wiring.spec.ts` 固定 PR 触发分支、`pr-scope` need、verdict 成员身份以及 `android-bridge` 保持不变的仅手动条件。

## 影响

diff 触及壳或已注册 Android 消费方的 PR 现在会被 debug 构建和 lint 阻塞,编译回归无法再静默落地。非 Android diff 零成本跳过该 lane。手动 `android-audit` 套件继续运行模拟器 bridge;若托管 KVM 可靠性改善,后续 note 可再评估是否提升它为必需。
