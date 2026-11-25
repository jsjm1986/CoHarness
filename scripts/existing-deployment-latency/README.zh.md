---
kind: reference
title: 现有 QA 部署延迟采样
summary: 通过显式执行，测量已经运行且已授权的个人 Runtime 的浏览器操作。
---

# 现有 QA 部署延迟采样

[English](README.md) | 中文

## 概要

[入口脚本](../measure-existing-deployment.ts)默认只打印计划。显式添加 `--execute` 才分别采样热新建、历史打开和文本持久受理，默认每项计划 50 次。它使用现有 Web UI、全新的私有浏览器上下文和[共用浏览器启动器](../../apps/web/tests/computer-browser.ts)，不启动夹具服务、不分配 Runtime、不修改权限。执行路径仍需真实部署验证，之后才能引用其耗时；离线测试只证明配置、计划和样本统计。

## 目录

- [配置](#configuration)
- [调用及影响](#invocation-and-effects)
- [解读测量结果](#reading-measurements)
- [开发说明](#dev-note)

<a id="configuration"></a>

## 配置

把 [config.example.json](config.example.json) 复制到仅当前账号可访问的目录，替换全部目标字段，并将文件权限设为 `0600`。配置、Cookie 和输出使用规范化的本机绝对路径，父目录也必须仅当前账号可访问。驱动端支持 POSIX 私有文件检查。它可以通过已有的本地隧道测量 Windows Runtime，也可通过 `browser.cdpEndpoint` 使用专用 Windows Chromium，但不创建隧道。配置的来源地址必须从驱动端和浏览器都能访问到同一个 Gateway。

| 字段 | 含义 |
| --- | --- |
| `origin`、`platform`、`release` | 带明确端口的已有回环地址、执行节点平台，以及操作者核对的冻结产物清单标识。版本标签不是服务端版本探测结果。 |
| `accountId`、`nodeId`、`runtimeId`、`workspaceId`、`workspacePath` | 已授权个人分配及已有工作区的准确身份。不根据显示名称或 Cookie 推断目标。 |
| `computerName`、`language`、`testModelLabel` | 当前电脑名、实际 UI 语言（`en` 或 `zh`），以及选中的受控模型名称。脚本核对名称，不改变模型设置。 |
| `historySessionId`、`historyTitle`、`historyMarker` | 工作区侧栏中已经可见、专用于测试且空闲的历史对话。标题和已知可见测试标记必须以 `testPrefix` 开头；使用简短历史，让标记位于已加载的尾页。 |
| `testPrefix` | `QA_PERF_` 后接 4–56 个字母、数字或下划线。新建确认后的对话使用此前缀、运行标识和序号命名。 |
| `authenticationFile`、`outputFile` | 只包含一个已有 `cookie_name=value` 的私有文件，以及新的 JSONL 记录路径。不替换已有输出文件。认证值不进入计划或记录。 |
| `samples`、`timeoutMs`、`settleTimeoutMs`、`intervalMs` | 每项操作的尝试上限、浏览器／HTTP 等待限制、已受理轮次的完成限制，以及操作间隔。默认分别为 50、30 秒、120 秒和 1 秒。 |
| `browser` | 明确指定引擎；可选已安装的 `executablePath`，或专用回环 Chromium `cdpEndpoint`。CDP 和可执行文件路径不能同时提供。不根据 `platform` 推断浏览器平台。 |

执行前，操作者核对 QA 模型使用已授权的受控地址、返回 `CANDIDATE_QA_ACCEPTED` 且不需要工具。显示名称相同不能证明提供方 URL。测量期间应独占资源窗口：不切换服务、不构建、不改变备份负载，也不同时进行其他测量。导航前、每轮操作前及每项测量操作后检查目录中的就绪状态，核对准确的 Runtime、个人所有者和电脑；归属变化时拒绝测量。现有协议允许请求省略 `dshNode`，但提供电脑参数时必须唯一并等于已核对的电脑。Runtime、目标类型、账号及版本化响应中的 Runtime 仍是必填条件。这些检查是热操作的前提，不是阻止其他人随后停止或迁移 Runtime 的锁。

<a id="invocation-and-effects"></a>

## 调用及影响

在仓库根目录执行以下命令，只读取私有配置并打印计划，不读取 Cookie、不启动浏览器、不访问目标地址，也不创建输出文件。

```sh
node --import tsx/esm scripts/measure-existing-deployment.ts --config /private/qa/measurement.json
```

部署负责人确认计划及测量窗口后，添加 `--execute`。这授权脚本最多创建并命名 `samples` 个专用对话，在每个对话中发送一次文本。打开操作使用配置的已有测试历史。脚本不授权、不改配置、不重试失败写入、不停止轮次、不删除对话或清理文件。结果未知或操作失败时停止后续写入；保留操作与 Session 标识，检查后再决定下一轮。创建已经确认、命名随后失败时，可能留下未命名的 Session，其标识仍保留在记录中。

脚本拥有新建的浏览器上下文及其连接，完成或中断时关闭它们，不影响已有标签页。Cookie 旁的私有排他锁阻止使用同一目录和 Runtime 的另一轮调用。崩溃可能遗留锁，手工删除前须确认其中记录的进程已退出。这个锁不能排除另一台电脑或另一份凭据目录中的调用。CDP 只能连接本轮专用浏览器。

准备过程明确展开配置的电脑和工作区，选择准确的历史行并等待已知标记，然后才开始测量。首次选择和每次打开历史前，脚本通过准确工作区的会话展开按钮及所属 Runtime 的目录分页按钮显示目标行，再将其滚入视野。行定位共用一个 `timeoutMs` 截止时间，并在点击时钟启用前完成；滚动、分页和可操作性检查不计入 `readyMs` 与 `driverMs`。采样中的历史打开若定位失败，仍计为失败尝试并停止后续采样。不预填浏览器的选择存储。自有上下文提供 `tsx` 序列化浏览器回调所需的函数命名助手。失败记录准备或操作阶段、DOM 计数和资源 ID，以及有数量上限且不含消息内容的请求路由元数据。守卫拒绝码优先于请求被中止后产生的响应等待超时。

<a id="reading-measurements"></a>

## 解读测量结果

输出为只追加的 JSONL：一条计划、每项已尝试操作的原始记录，以及最后的汇总。仅记录标识、安全结果码和耗时，不记录消息、工作区路径、Cookie 或响应正文。每项分别报告计划、尝试、成功、失败、超时和未执行数量、失败率，以及最近秩法计算的 P50／P95。缺失值为 null，未执行操作不算成功。提示已持久受理但模型未正常结束时，保留成功的持久受理记录，并另记完成失败；不再继续采样。

持久受理确认要求版本化准入端点、准确的 Session 和应用请求 ID、匹配的 RPC 响应 ID，以及肯定的结果。Host 为此端点强制设置 `durable: true`；普通 `/api/session.prompt` 受理、HTTP 200、界面回显和模型输出都不能作为证明。恢复状态必须对应同一原始请求。

采样器先把 `durable-send-accepted` 检查点同步到磁盘，再读取浏览器时钟或等待可见回复。如果最终样本或汇总尚未写入，检查点仍能确认该次提示已受理。它没有回复耗时，也不另计为一条操作样本。每个目标使用独立的输出文件，即使目标未测完也保留完整的 JSONL 行。

`operationId` 使用响应头 `x-dsh-operation-id` 的有效 UUID；仅在该响应头缺失时使用请求 UUID。该标识用来关联 Gateway 计时记录，不能证明持久受理。汇总的 `resourceTraces` 最多保存 32 条所选 QA 目标的结构化启动、带修订号组合脚本和文件读取观测，只记录阶段、固定类别、HTTP 状态或网络失败码及可用的 UUID，不增加请求，不保留资源 URL 或内容。汇总同时记录浏览器的 `dsh:boot:*` `bootMarks`（首次打开失败但页面可读时也保留）以及分为 `boot` 与 `setup` 两阶段、仅含路径名的 `initialRpcSummary`（每阶段最多统计 64 个不同的 `/api/*` 或 `/account/api/*` 路径，含次数、状态分布与 `maxMs`）。被测操作失败且浏览器已无法读取收尾标记时，采样器保留原始失败原因，不将其覆盖。

命名不计入测量操作。其普通 RPC 路由确认匹配的请求 ID、准确的合成标题及标题事件序号；只有版本化准备／准入路由要求 Runtime 响应头。Runtime 目录读取在响应字节超过一 MiB 时停止并取消。

| 终点 | 测量含义 |
| --- | --- |
| `editableMs` | 浏览器点击事件到准确 Runtime 的准备视图可输入。 |
| `readyMs` | 浏览器点击到新建界面就绪，或已授权历史视图呈现已知标记。 |
| `durableReceiptMs` | 浏览器 Enter 事件到收到所属电脑的提示／状态持久受理确认。包含传输时间，不是纯服务端提交耗时。 |
| `firstVisibleAnswerMs`、`completionMs` | 浏览器 Enter 到助手回答文字可见，以及受控回复结束。两者都不是模型服务端的首字时间戳。 |
| `driverMs` | Playwright 命令与等待开销，独立于浏览器事件时钟记录。 |

分位数描述成功终点，失败样本仍保留观察到的可输入时间。若响应包含 `hostDurationMs`，它覆盖整个 Host RPC，而非仅数据库持久化。服务端提交时间戳和模型首字时间戳明确标为未观察。资源遥测点不是操作样本。对比时须保持产物清单、账号及授权、所选模型、数据、浏览器位置、网络和负载一致；本机合成的 500 毫秒夹具不等于已部署 Mac 或 Windows 的结果。

<a id="dev-note"></a>

## 开发说明

[离线测试](config.spec.ts)覆盖私有输入、显式执行、精确身份和统计。[合成浏览器测试](../../apps/web/tests/personal-runtime-latency.e2e.ts)复用点击时钟，但独立拥有自己的服务和数据。[准入决策](../../.agents/notes/implemented/architecture/2026-11-04-node-qualified-conversation-admission.zh.md)说明持久受理和身份保留。这两类测试都不能替代在经审阅的 QA 部署上实际运行此入口。

[采样决策](../../.agents/notes/implemented/testing/2026-11-17-existing-deployment-latency-sampling.zh.md)记录部署测量与合成回归夹具保持分离的原因。
