# Agent Note：模型治理 default-deny 与用户声明（BYOK）路由授权

Status: implemented

[English](2026-08-17-model-governance-byok.md) | 中文

## 问题

模型治理最初对 `admin` 角色有 `defaultAllowed` 旁路：治理目录外的路由对管理员放行，因此管理员的用量可能出现在账本中但价格为零，使成本统计失真。用户在设置中配置自己的 provider（DeepSeek API key、自定义 OpenAI 兼容网关）后，被治理插件的 fail-closed 语义拒绝（普通用户 `defaultAllowed: false`），产生困惑的死路：设置页显示 provider 已配置，但模型选择器不显示任何模型，每次发送返回 `MODEL_FORBIDDEN`。同时，admin 模型页可以登记 `(provider, model)` 路由用于授权和计价，但这并不能让模型真正可用——baseURL、协议和 API key 仍需在用户自己的设置中配置。"管理员授权"和"用户配置"的分裂意味着一个新模型上线需要两个界面、两种角色配合完成。

## 决策

1. **移除管理员 `defaultAllowed` 旁路。** 治理目录是每个角色的唯一授权来源。目录外的路由对所有角色拒绝。目录内角色默认（登记时设置的 `adminAllowed`/`userAllowed` 标志）不受影响。

2. **个人运行时允许用户声明（BYOK）路由。** 治理目录中不存在的路由，当实例自己的 settings user 层声明了该 provider 时授权。用量照常记录：目录无价则估算成本为 0，个人凭证归属使公司成本为 0。项目共享运行时不开 BYOK。

3. **目录路由优先。** 治理目录中的路由始终按目录条目的 `allowed` 标志决定，即使 user 层也声明了相同 provider。目录 deny 不可被 user 层重声明覆盖。

4. **DeepSeek provider 编辑器在 user 层记录 `apiKeyEnv`。** 现有的 pi-ai 物化逻辑（在全新 profile 上输入 key 时写入约定凭证引用）现在也适用于 `llm-deepseek` section 根路径，使两个 adapter 家族都产生一致的"用户配置了此路由"信号用于 BYOK 机制。

## 机制

- 网关将 `userDeclaredAllowed: true`（个人运行时）和 `false`（项目运行时）写入策略文件（`apply-model-governance.ts` 中唯一的 `writeProjection` 函数）。
- 插件验证新字段，缺失或类型错误时在启动时响亮失败。
- `ReloadableModelAccess` 增加 `userDeclared` 查找回调。判定顺序：unavailable → 目录路由 → (userDeclaredAllowed && provider 有 user 层 profile) → defaultAllowed。
- `UserDeclaredRoutes` 类维护 provider 集合，在 `llm/adapters-updated` 和 `settings/document-updated` 事件时通过 `ctx.llm.listConfigurableProviders()` + `ctx.settings.describe()` 刷新。
- `dsh-settings` 是编译期（type-only）依赖；编译产物保持无运行时导入的约束。

## 备选方案

- **网关级策略投影**（在网关侧解析用户的 settings.yaml 并将 BYOK 路由集写入策略文件）。拒绝原因：需要网关监视每个用户的 settings 文件，重复了 settings seam 的热重载。
- **使用 configurable-provider 目录的 `declared` 标志**作为 BYOK 信号。拒绝原因：有用户 key 的已发货路由（如 `deepseek-official`）的 `declared` 为 false（pi-ai 提供），但用户自己的 key 应算作 BYOK。
- **保留管理员 `defaultAllowed` 旁路**，依赖目录的角色默认进行管控。拒绝原因：旁路使管理员测试未登记模型时的成本统计不可靠。

## 相关文件

- `plugins/dsh-model-governance/src/policy.ts` — `userDeclaredAllowed` 字段 + 校验
- `plugins/dsh-model-governance/src/user-routes.ts` — 新建
- `plugins/dsh-model-governance/src/access.ts` — 判定顺序
- `plugins/dsh-model-governance/src/index.ts` — 事件接线
- `gateway/src/postgres/model-governance-service.ts` — `defaultAllowed: false`
- `gateway/src/model-governance.ts` — `defaultAllowed: false`
- `gateway/src/services.ts` — 收紧返回类型
- `gateway/src/apply-model-governance.ts` — 投影字段
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` — deepseek apiKeyEnv 物化

## 影响

治理目录现在是每个角色的唯一授权模型来源，成本统计因此可靠。在设置中配置个人 provider（BYOK）的用户会立即在模型选择器中看到这些模型并可使用；用量以个人成本归属记录，目录无价按 0 计。项目共享运行时保持目录唯一，因此项目成员不能添加个人 provider。DeepSeek provider 编辑器也在 user 层写入凭证引用，使两个 adapter 家族产生一致的"用户配置了此路由"信号。新的 `userDeclaredAllowed` 字段在策略文件中是必填的——写入它的网关与更新后的插件兼容，但插件在缺失该字段时会在启动时以清晰错误信息拒绝。`defaultAllowed` 现在对每个角色写 `false`，管理员旁路已移除；需要测试未登记模型的管理员必须先将其登记到目录中。