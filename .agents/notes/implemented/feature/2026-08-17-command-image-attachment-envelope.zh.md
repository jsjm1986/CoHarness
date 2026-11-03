# Agent Note: Command image-attachment envelope

Status: implemented

[English](2026-08-17-command-image-attachment-envelope.md) | 中文

## Problem

Web composer 的一次提交是一个信封——草稿文本、已附加图片、投递模式——但两条提交平面对它的消费是不对称的。普通消息走 `defaultSink → conversation.sendSession`，图片被序列化进 prompt 内容并在成功后清除。被 claim 的斜杠命令走 `claim.submit(args, actx)`，一个纯文本事务：`/goal rebuild the cathedral` 带四张参考照片时，命令执行、草稿清空，图片却静默滞留在 composer 附件栏。模型从未看到它们，也没有任何界面提示。这个缺陷在契约层面而非某个漏掉的调用点：claim、裁决、宿主执行器都没有建模附件，因此任何命令都可能消费提交的文本一半而丢弃其余部分。

合并两个平面从未在考虑范围内——[插件命令注册 Agent Note](../../archived/feature/2026-07-19-plugin-command-registration.md)刻意让人类命令留在模型平面之外，这个分离是正确的。问题在于信封在平面分叉处被拆散了。

## Decision

提交信封被端到端建模，每条命令路径要么整体消费它，要么响亮拒绝。

**声明。** `CommandDefinition.input.attachments: boolean`（缺省为 false）声明调用是否接受 composer 附件。该标记随选中的命令经过目录发现与输入裁决。

**带类型的提交载荷。** 命令 wire 携带 `CommandSubmitAttachment[]`：编码图片和限定到会话的暂存文件凭证。上传所有者为接收 Agent 解析每个文件凭证；通过准入的图片和文件按最初选择顺序传给处理器。

**执行器强制。** `CommandRuntime.execute(agent, line, attachments, signal)` 在处理器入口前强制执行声明。不支持的附件、缺失的附件存储、未知文件凭证及图片批量限制均以已记录的错误结算。图片验证采用共享附件准入路径；验证拒绝不会开始写入。通过准入的内容块组成冻结的 `invocation.attachments` 数组。

**调用者存续期。** 等待中的准入与实际处理器 promise 归属确切的 Agent，因此自动空闲释放必须等待两者完成。UI 等待被取消不代表处理器清理已结算。强制释放或替换仍可能在存储等待期间关闭 Agent；执行器会在处理器入口前重新检查捕获的注册表，且绝不把旧调用转交给具有相同 Session id 的替代者。没有 Agent 注册表的独立组合仍由调用方管理存续期。 服务撤下会中止已接收的工作，拒绝旧引用准入，并等待实际处理器 promise。组合的 Cordis effect 会将空闲释放监听器保留到这些工作完成。

**注册项归属。** 附件存储和同步会话监听器的处理可能越过命令贡献项的存续期。执行器在处理器入口前检查捕获的注册项仍然生效，包括限定到 agent 的覆盖。移除或替换会以错误关闭现有生命周期事件对，调用不会转交给其他注册项。重新发起调用时才解析当前处理器。

**模型可见性由生产方负责。**注册表自身绝不调度这些图片。`/goal` 在 create 或 edit 成功后通过 `agent.followup` 提交一条用户消息——图片块加固定文本 `Reference images for the goal objective.`——后续 Goal Round 从普通会话历史读取图片，goal 领域不存储附件状态。`/plan <message>` 把图片并入其 steer 的文本消息；不带参数的 `/plan` 则 steer 一条只含图片的用户消息，因为图片可能包含全部任务内容。不会发送模型输入的控制形式（`/goal pause`、`/plan off`）会直接返回错误，composer 的图片原地保留。plan 投影会把 `command/run` 视为候选选择，并在配对的 `command/done` 报错时只丢弃该候选目标。被拒绝的带附件命令既不会创建待退出状态，也不会抹掉较早成功的待生效选择。投影状态版本 4 会按此规则重新折叠已缓存会话；无密钥 Loader 记录验证命令拒绝、实时与回放的待生效状态一致，以及下一步实际应用选择。

**composer 的拒绝是可见横幅，一切保留。**ui-commands 的 `matchEnter` 从裁决收到 `SubmitEnvelope`（图片数量），对每条无法消费图片的回车路径抛出本地化的 `notice.imagesUnsupported` 拒绝：contribution 弹窗、decoration 弹窗、未声明的 claim、bare 分离执行。输入状态机发布一条错误通知，composer 通过瞬态 Toast 横幅呈现它，草稿与图片不动。已 claim 状态下的提交（空格或菜单 claim）由 facade 用 `conversation` 命名空间的同款文案把关。接受路径上，facade 经 hub 的 `commandImages` 管道序列化草稿图片、传给 `claim.submit`，仅在成功 outcome 后清除并释放；错误结果（包括生产方的语法拒绝）保留它们。

命令的 run 事件即使不带附件，也可能同步取消请求，因此普通提交和附件提交必须在共同的处理器入口检查取消。新的 `/plan` 文本和附件属于人类发起的执行输入：不可变 Gateway 凭证先于模式选择与排队投递，才能保留调用者限制，避免成为身份未验证的历史。同一次等待也可能越过提供方、服务或原 Agent 的存续期；迟到的完成不能选择模式或排入输入。

## Testing

注册表执行器强制、准入失败结算、冻结的调用附件由 `packages/interaction/commands/tests/commands.spec.ts` 覆盖；批量准入顺序与限额在 `packages/attachment/attachment/tests/admission.spec.ts`；生产方行为在 `packages/goal/command-goal/tests/command-goal.spec.ts` 与 `packages/plan/plan-mode/tests/plan-mode.spec.ts`；客户端拒绝与消费路径在 ui-commands、ui-conversation、ui-input-trigger 客户端套件；组装后应用流程在 apps/web 的 keyless 通道。

## Alternatives considered

- **附加图片时一律拦截命令（没有接受路径）**——被拒绝：可预测，但带参考图的 `/goal` 正是驱动这次修复的用例，用户的图片将完全没有通往模型的路径。
- **任何命令后把滞留图片自动作为后续用户消息发送**——被拒绝：对宿主状态命令（`/model`、`/compact`）令人意外，且把消息契约从生产方挪到 composer，违反命令注册表「生产方负责模型可见工作」的规则。
- **在 goal 领域存储附件引用并渲染进 Round 提示词**——被拒绝：需要持久化 goal schema 变更，且要么把图片块复制进每轮提示词，要么引入仅首轮的提示词形态；round 提示词不变量将需要附件状态。一条普通的已记录用户消息达到同样的模型可见性。
- **只要命令成功就消费图片，不管语法**——被拒绝：`/goal pause` 带图会把图片静默丢弃，在更深一层重演原始缺陷。消费与生产方的显式成功绑定，语法不匹配返回错误。
- **只在客户端强制**——被拒绝：schema 省略不是强制执行；直接 RPC 调用方可以绕过 composer。执行器自己结算声明。
- **不带类型标记的多媒体标识**——被拒绝：图片字节和暂存文件凭证需要不同的准入方式。带类型标记的联合类型保留上传所有者的会话检查与图片批量策略。

## Consequences

- 任何命令路径都不可能消费提交的文本而滞留图片：契约强制整信封消费或可见拒绝，对现有与未来命令一体适用。
- commands 包新增对 `dsh-attachment` 与 `dsh-llm` 的依赖，`commands/execute` 携带必填的 `attachments` wire 参数——每个调用方都显式陈述其信封。
- `/goal` 与 `/plan` 获得参考图输入，代价是一条额外的已记录用户消息（goal）与 steer 消息中的图片块（plan），其中不带参数的 `/plan` 会产生只含图片的消息；所有这些输入的计费都与常规图片提示词相同。
- 菜单点选的弹窗流程不查询信封：附有图片时从菜单点选弹窗命令，图片会可见地留在附件栏，而不是拒绝该交互。回车提交是被强制执行的信封边界。
- 「被拒绝的批量不发布任何持久化对象」只覆盖准入前的三种结算（声明、存储缺失、批量超限）。handler 级语法拒绝（如 `/goal pause` 带图）与准入后取消发生在批量已提交之后，会留下没有会话事件引用的内容寻址对象——在 sha256 去重与附件存储延后的引用感知 GC 下无害，但并非「未写入任何对象」。
