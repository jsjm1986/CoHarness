# `@deepseek-ai/dsh-file-reference`

[English](README.md) | 中文

文件引用发现 seam，以及供宿主驱动的用户界面共享、可在浏览器中安全使用的 `@file` 语法。`ctx.fileReferences.list(agent, query, signal)` 为指定 agent（智能体）返回仅含路径的文件或目录候选；具体提供方负责命名空间访问、排序、缓存和失效处理。同一契约以一元 `fileReferences/list` Remote 方法对外可调（`@Remote` 标注在 Service Definition 上，经保留的末位 signal 参数取消），浏览器消费方直接调用 `ctx.remote.fileReferences.list`，无需 API Proxy 路由。

`activeAtToken()` 只在输入开头或空白后识别 `@path` 或尚未闭合的 `@"path with spaces` token，因此类似电子邮件的文本不会打开补全。`formatFileMention()` 会生成与提示词匹配的写法，为目录候选追加 `/`，保留显式打开的引号，并拒绝编辑器语法无法安全表示的控制字符或内嵌引号。

选择候选项不会读取或附加文件内容。导出的 `FILE_REFERENCE_PROMPT` 是稳定指引；当指定 agent 可以调用 `read` 时，提供方可以安装该指引。

## 概述

宿主驱动 UI 使用 `dsh-file-reference` 提供 `@file` 补全：UI 为指定 agent（智能体）请求路径候选，模型输入 `@path` 或 `@"path with spaces"`，选中候选后，匹配的 mention 作为普通提示词文本插入。seam 本身不拥有文件系统访问——具体提供方（如 `@deepseek-ai/dsh-file-reference-local`）负责提供候选、排序、缓存与失效。选中候选绝不读取或附带文件内容；模型必须调用文件系统工具才能查看文件。Session Controller 通过 `fileReferences/list` Remote 向浏览器消费方暴露同一发现能力。

## 不变量

**运行时不变量：** 未发布配套入口。该 seam 定义列表契约与 `@file` 语法；索引、缓存与失效由提供方拥有。

## 模型体验

间接影响模型体验：本包的发现 seam 与语法把文件引用指引委托给组合的提供方，由它负责呈现。

#### KV Cache 影响

接口与语法本身不增加请求 token；提供方拥有的提示词段决定可复用前缀是否改变。

## 已知限制与暂缓事项

- **路径候选仅供参考**：该 seam 不保证后续面向模型的文件系统工具能够访问同一命名空间；部署时必须让提供方与实际生效的 `read` 实现对齐。
- **没有文件内容引用对象**：所选文件仍是普通提示词文本，其内容必须经过模型显式调用工具后才对模型可见。
- **`zod` 是生成的 Typert 契约面的运行时依赖，不是 `src` 的依赖。** 发布的 `./typert` 与 `./remote` 出口解析到不经打包的 `lib/typert.*.js` 文件，其中包含裸 `zod` 导入。manifest 必须保留 `zod`；只有当两份生成 JavaScript 契约面都不存在时，`knip.config.ts` 才注入 workspace 级例外，已构建 checkout 则由 Knip 直接观察该导入。
