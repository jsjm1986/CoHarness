# dsh-model-governance

[English](README.md) | 中文

树外的每实例策略插件。它读取网关生成的 `model-governance.json`，发布 `ctx.modelAccess` 与 `ctx.modelProviderConfig`，把 Gateway 提供的组织凭据注册为只读层，在适配器派发前强制检查每次 `llm/stream` 调用，并先将用量提交到崩溃安全的本地 outbox，再上报到 Bearer 鉴权的回环网关 intake。运行中的实例会监视策略文件的父目录，因此 Gateway 原子替换策略后无需重启实例即可生效。启动时策略缺失或格式错误会令插件激活失败；运行中替换为无效文件时会进入 fail-closed 状态，直到下一份有效策略到达。

该 bundle 会为 Gateway 启动的每个个人和项目实例挂载 `dsh-gateway-runtime`。它的 peer 服务包由宿主安装提供，因此插件与挂载的运行时共享同一份 Cordis 实例。

策略与用量记录不包含 API Key、提示词或回复内容。组织凭据在 Gateway 数据库中保持加密，只在适配器解析其引用时通过已鉴权的回环运行时 API 传递。凭据来源只是用于区分公司与个人成本的非秘密层标识。以 UUID 命名的 outbox 文件通过同目录 rename 提交，仅在 intake 成功响应后删除；intake 去重使重试安全。

个人 settings 成功提交后，还会为 Provider/model 的新增、修改和删除生成 `model-registration` 记录。插件挂载时会为 user settings 层中已经存在的身份生成确定性基线记录，重启重放时按事件 ID 幂等。记录只包含路由身份、动作、作用域和时间戳，绝不包含凭据引用值、profile 内容、标头、提示词或回复。它们与用量记录共用 outbox 和 intake 令牌，但 Gateway 存储和管理员查询会把登记历史与调用用量分开。项目运行时不会产生个人登记记录。

## 组织 Provider 与凭据

策略中的 `providers` 数组是供 LLM 适配器消费的不可变、已启用组织 Provider 快照。组织路由 id 使用保留的 `org-*` 命名空间，绝不进入可编辑的用户设置。Gateway 管理页面直接复用完整的 Models 设置插件，因此管理员会通过与个人 Provider 相同的编辑器配置协议、端点、API Key、模型列表与模型发现，再配置角色、用户和项目默认规则或单路由例外。每份 profile 经组织 facade 持久化后投影进快照；治理页面不维护第二套删减版 Provider 表单。Gateway facade 与运行时加载器会在持久化或发布前校验同一组受管 pi-ai 字段：`compat` 只包含 `thinkingFormat` 与 `supportsReasoningEffort`，非空 compat 只适用于 `openai-completions`，推理映射与 thinking budget 只能使用受支持档位，重试策略采用有界退避，流空闲定时器也必须落在 Node 定时器范围内。发布器会克隆并递归冻结完整 profile，因此适配器 Consumer 无法改写活动快照中的标头、推理映射、重试配置、输入模态或模型条目。

`DSH_` 凭据引用命名空间只属于组织 Provider。可编辑的个人 `llm-pi-ai` settings 会拒绝 `DSH_` 引用和 `org-*` 路由。凭据层独占当前快照中的每个引用，并在每次模型请求时通过 `/internal/runtime/model-credential` 解析。Gateway 在返回值之前执行用户或项目模型授权。值不存在或请求失败时绝不回退到同名个人存储，个人配置界面看到的组织引用也是只读的。

组织路由必须显式列出模型。`modelOverrides` 只适用于 catalog 路由，因此不会出现在组织编辑器中；非空值会同时被 Gateway settings facade 和运行时策略加载器拒绝。

个人运行时组合已授权组织路由与用户声明的个人 BYOK 路由。项目运行时设置 `userDeclaredAllowed: false`；其模型权限来自项目默认规则和单路由例外，因此同一项目运行时的所有成员看到相同的组织模型集合。

## 授权判定顺序

对每个 `(provider, model)` 路由，插件按以下顺序判定：

1. **策略文件不可用**（运行中损坏）→ 拒绝 `POLICY_UNAVAILABLE`。
2. **路由在治理目录中** → 按目录条目的 `allowed` 决定（目录 deny 不可被 user 层声明覆盖）。
3. **路由不在目录且 `userDeclaredAllowed` 为 `true`** → 当实例的 settings user 层声明了该 provider 时放行（个人 BYOK），否则拒绝。
4. **回退到 `defaultAllowed`**（网关现在对每个角色都写 `false`）。

禁止的路由在 provider 派发前以 `MODEL_FORBIDDEN` 结束 stream。`userDeclaredAllowed` 由网关写入：个人运行时为 `true`，项目共享运行时为 `false`。

## 用户声明 provider 的发现

插件跟踪实例 settings 文档中 user 层声明的 provider 路由。集合在每次 `llm/adapters-updated` 和 `settings/document-updated` 事件时通过 `ctx.llm.listConfigurableProviders()` 和 `ctx.settings.describe()` 刷新，因此用户在设置 UI 中添加 provider 后无需重启即可生效。

## 模型体验

被禁止的路由在 provider 派发前以 `MODEL_FORBIDDEN` 结束 stream。发起 Agent 身份与显式 `sessionId` 不一致时以 `MODEL_ATTRIBUTION_CONFLICT` 结束。插件不添加任何提示词内容。

#### KV Cache 影响

无直接影响。

## 运行中策略重载

Gateway 会把完整策略写入临时文件，再 rename 到目标路径。插件监视父目录，在替换授权前先加入新的 Provider 路由，在授权变化后移除退役路由，并同时更新用量 intake 目的地。`llm/stream` 调用在准入时取得自己的授权决定与 Provider 配置，因此策略更新不会在已经运行的 stream 中途改变决定。运行中的策略文档缺失或无效时，新的模型请求会被拒绝；用量上报暂时继续使用最后一份有效策略中的 intake 目的地，直到新的有效文档发布。

## 已知局限与延后工作

- **额度只提示**——80%/100% 阈值提醒不会拒绝原本已授权的调用。
