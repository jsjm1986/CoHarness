# Agent Note: Gateway 插件必需测试

Status: implemented

[English](2026-09-17-required-gateway-plugin-tests.md) | 中文

## 问题

根 Vitest 包含模式之外的 Gateway 插件套件需要显式的必需 CI 执行；仅插件变更也需要触发 Gateway 集成检查。

## 决策

根目录 [`test:plugins`](../../../../package.json) 运行 `dsh-directory-guard` 与 `dsh-model-governance` 的 Vitest 配置。[run-gates](../../../../scripts/run-gates.ts) 在 `ci-primary`、`ci-linux-primary`、`ci-consumers`、`ci-consumers-scoped` 和 `check-all` 中把两者作为必需检查运行。两个配置都使用根目录 [`tsconfig.base.json`](../../../../tsconfig.base.json) 的源码路径和 [`standardDecoratorPlugin`](../../../../vitest.shared.ts)。两个插件目录前缀都通过[作用域策略](../../../../scripts/ci-scope-policy.json)选择 Gateway 车道。

## 考虑过的替代方案

**仅由 Gateway 车道执行。** 否决，因为[独立的 Gateway 车道](../process/2026-09-15-standalone-gateway-lane-source-resolution.zh.md)不会运行插件套件。

**手工维护的源码 alias。** 否决，因为根目录源码路径已负责工作区解析；共享装饰器转换服务于被引用的源码。

## 影响

插件失败会阻塞所属聚合，且不依赖已构建的工作区产物。独立的 Gateway 车道继续承担各自的集成职责。

## 测试

[`run-gates.spec.ts`](../../../../scripts/run-gates.spec.ts)、[`ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) 与 [`ci-pr-scope.spec.ts`](../../../../scripts/ci-pr-scope.spec.ts) 覆盖必需执行、失败的子进程、workflow 归属和插件前缀选择。两个插件套件已在本地通过。缺口：源码套件不证明打包后的插件加载或已部署的关闭行为；未声明托管 CI 运行结果。
