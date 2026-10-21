# Agent Note：提供方元数据驱动 Models 编辑器的原生认证检测

状态：已实现

[English](2026-10-19-provider-metadata-auth-detection.md) | 中文

## 问题

目录路由可以通过 pi-ai 解析器原生读取的环境变量完成认证——`OPENAI_API_KEY`、`ANTHROPIC_AUTH_TOKEN`——但 Models 编辑器此前只描述卡片自己要写入的引用，已配置的环境与缺失凭据看起来完全一样。走 OAuth 流程认证的路由、端点由环境变量构造的路由，此前根本没有表达方式：编辑器给出一个它们用不了的 API 密钥输入框，也没有任何端点真实来源的提示。

## 决策

`LlmConfigurableProvider` 现在携带三个从已安装 pi-ai 目录生成的目录事实：`defaultBaseURL`、`baseURLEnv` 与 `nativeAuth`（`env` 名加 `oauth` 标志）。`llm-pi-ai/scripts/gen-provider-data.ts` 确定性地产出 `provider-data.generated.ts`，`pnpm verify-provider-data` 拒绝过期的已暂存文件；`directoryEntries` 把每条路由的补充数据合并进可配置路由。API 代理把同样三个字段投影到 `ConfigurableProviderView` 上，设置存储在同一次批量 `credentials.describe` 中描述每个无凭据行的原生引用——`nativeAuth.env` 减去 `baseURLEnv` 名（后者构造端点而非携带凭据）——并作为 `credentialChecks` 折叠到行上。

编辑器保留 fork 的作用域凭据模型而非照搬上游的线型结构：卡片仍按管理作用域派生其写入引用，但它的单次 describe 现在覆盖该引用加该路由会读取的每个认证引用。检测是方法中立的——含 OAuth 名字的变量会被检查但绝不展示，由此产生不具名的"已检测到环境变量"提示——而命名了 `apiKeyEnv` 的配置文件会整体遮蔽原生认证，因为命名引用是适配器唯一读取的凭据。唯一原生认证是 OAuth 的路由不再展示它永远满足不了的 API 密钥字段，端点字段依次回退：已配置的 `baseURL`、目录 `defaultBaseURL`、再到 `baseURLEnv` 提示行。

## 曾考虑的替代方案

**照搬上游纯属性驱动的编辑器并去掉卡片自身的 describe。** 否决：fork 的作用域模型意味着写入引用只在编辑器派生处存在（`personal`/`organization`/`project` 前缀与所有原生名都不同），卡片仍需自行 describe 其引用；行上的 `credentialChecks` 是预描述的回退，而非替代。

**把已配置的作用域引用当作原生检测。** 否决：组织或项目作用域引用是本页写入的已存凭据，不是路由原生的环境名；只有目录 `nativeAuth.env` 成员进入检测链，作用域引用通过其 `file` 来源提供已保存凭据信号。

**在帮助文本中展示可 OAuth 的变量名。** 否决：OAuth 令牌名不是用户粘贴 API 密钥的去处；`visibleRefs` 把它们过滤出展示，但保留在检查链中，使其已配置状态仍能产生不具名检测提示。

## 后果

每条 pi-ai 目录路由如实报告其原生解析器读取的凭据：已检测、缺失、未确认或已存文件，Models 行徽标把原生检测计入 `keyConfigured`。仅 OAuth 的路由保持可配置且没有死输入框。`declared` 路由保持普通密钥字段——不报告原生认证的适配器不会得到提示。生成文件与其他目录一样暂存并校验；提升固定的 pi-ai 版本会重跑 `gen-provider-data`，否则验证失败。

## 验证

`native-auth.spec.ts` 断言生成表与已安装目录的解析器环境元数据逐条一致，且元数据读取期间不执行任何凭据。`components.client.spec.tsx` 覆盖仅 OAuth 的字段抑制、命名引用遮蔽、方法中立后备列表、不具名检测、端点变量排除、端点提示位置与三种检查态。`catalog.spec.ts` 与 `dynamic-config.spec.ts` 在真实目录条目上钉住线路暴露。
