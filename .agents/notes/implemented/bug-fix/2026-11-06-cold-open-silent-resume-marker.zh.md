# Agent Note: 启动读取不再与静默 resume 标记竞争

Status: implemented

[English](2026-11-06-cold-open-silent-resume-marker.md) | 中文

## Problem

打开已保存会话会发出两次 `/api/session.history`:detached 预读在会话挂接前完成,`Session` 构造器随后追加 `session/end-seed` —— 一个在 store 条目建立前就已提交的持久事件,因此没有任何 `session/event` 观察者见过它 —— 而 `session/subscribed` 基线报告的 `session.seq - 1` 越过了客户端窗口尾,迫使 `repairGap` 为这一个标记重拉相同的历史页。同一打开流程还在用户不知情时恢复了 Agent —— 而且有两处来源:`sessions.models` 仅为填充选择器就调用 `agentFor`,而命令输入源在 scope 诞生时触发的 `warm` 钩子发起了 `commands.list`,其 `agent` 参数同样经 `agentFor` 解析;两条只读加载各自冷恢复了会话、追加了标记,并凭空造出一个活跃 Agent。

## Decision

mux 的 `subscribe()` 把静默后缀 —— `session.firstLifecycleSeq` 起、从未产生过 `session/event` 帧的持久事件 —— 在 `session/subscribed` 基线之前下发。已打开的客户端窗口以 `tail + 1` 实时缝合该标记,基线落地时已被覆盖,不再触发 gap 修复。回放必须放在共享的 `subscribe()` 内部而不是 `session/created` 监听器里:resume 时发射的 `session/event` 会把各自的 `subscribe(seq - 1)` 发布排在 created 发布之前先行冲刷;早于流开启就挂接的会话也经 `initialSessions` 走同一条路径,因此所有订阅路径都只覆盖一次静默窗口。`session/created` 发布以挂接时刻的 `seq - 1` 为上界回放,连同 enter 窗口内的追加一并覆盖;其余路径统一止于 `firstLiveSeq` —— 构造窗口 —— 因为构造之后的事件要么已由上一代流投递、要么由客户端历史读覆盖,回放它们会把整个会话生命周期灌进每次重连。

`sessions.models` 对 Agent 既不活跃也未在恢复中的会话,直接由持久日志作答而不再走 `agentFor`:`detachedSelection` 用 `modelSelectionProjectionDefinition` 折叠事件得到 pending 层、用 `foldRequestHeader` 得到已记录的请求头层,完整镜像 `selectionFor` 的分层,包括省略 adapter 默认推理档位的规则。subagent 归属栅栏先于所有分支执行,与 `agentFor` 的顺序一致;已在途的恢复仍然被汇入。

命令源不再注册 `warm` 钩子:预期式的目录预热会解析一个 `agent` 类型的远程参数,不激活它要服务的冷会话就无法运行。`CommandDirectory` 本就是惰性拉取 —— 首个 `candidates`/`matchEnter`/`matchSpace` 读取会调用 `ensureReady` —— 目录改为在 `/` 意图出现时加载,而恢复该会话 Agent 在此时才属正当。`directory.warm()` 已无任何调用方,一并移除。

移除 `warm` 同时删掉了打开流程唯一的 Agent 解析,因此"打开发布 Agent"契约改由 `session.activate` 承载:一个类型化 RPC,按 write 域授权、拒绝已归档会话并解析 `agentFor`(幂等恢复)。客户端从 `sessions.open` —— 选择边界 —— 而非呈现处触发它:`SessionManager.activate` 记录该意图并发出 RPC,而自动选择路径(启动 `startInitialSelection`、保留的 workbench 窗格聚焦)传 `activate: false`。挂载本就不可能构成边界:conversation slot 在选择加载遮罩下就已渲染,且启动规格要求自动恢复的 current 会话在呈现后保持冷态。`handleConnected` 仅对已在 `activated` 集合中的身份重新激活,因此重启只会重新发布用户显式打开过的 Agent,而不会恢复仅被呈现过的会话。

## Alternatives considered

**在基线中报告页内口径的 `lastSeq`。** `session.seq` 是连续日志长度且每个序号都是真实事件 —— 标记也不例外 —— 不存在"被过滤"的口径;低报它会把一次持久追加对投影隐藏。

**把 gap 修复推迟到 live 事件到达之后。** 这只是掩盖表象:标记仍是持久的且仍不在流中,重连或迟到的 open 之后还会撞上同样的重拉。

**`sessions.models` 保留 `agentFor`,只回放标记。** 它能修掉历史读数,但仍为一次持久日志本可作答的读取恢复了 Agent,违反"打开已保存会话不产生 Agent"的启动契约。

**保留 `warm`,但仅在存在活跃 Agent 时拉取。** 客户端快照不暴露 Agent 存活事实,钩子无法区分"免费预热"与"冷恢复";用 `running` 之类的启发式门控会在静止中的活跃 Agent 上误判。`commands.list` 也可以像 `sessions.models` 那样加一条 detached standing-scope 目录路径,但 standing 组合的命令视图与 Agent 解析后的视图并不一致,而惰性路径已满足全部消费方。

**在 conversation 挂载处触发 `activate`,以就绪门控约束。** slot 注入曾暴露 `activate` 与 `hooks.activationReady` 源 —— 初始选择未决或所需权限缺少已验证账户时为 false —— 组件在就绪翻转时激活。它有两处失败:自动恢复的 current 会话同样触发挂载(启动规格在呈现后仍断言 `agents.get(id) === undefined`,呈现并非意图);且服务器重启后门控不会重跑,重连的客户端便失去了 resume 本可产生的 `session/created` → `session/subscribed` 挂接。选择边界同时解决两者:显式 `sessions.open` 才是契约所奖励的用户意图,重连重激活则回放重启所摧毁的那份意图。

## Consequences

启动自动选择端到端断言 `historyCalls === 1` 在慢速 CI 时序下成立;同规格中 `ctx.agents.get(id) === undefined` 在呈现后也成立,因为被恢复的 current 会话不经过 `sessions.open`。任何构造期静默追加 —— 不只 `session/end-seed` —— 都在每条订阅路径上由同一循环回放,而真实缺失的历史仍按原样走 `mergeTail` 修复。`sessions.models` 对冷会话不再执行 live SSH 准入;读取仍由授权门控。在冷会话中输入 `/` 会恢复其 Agent —— 这正是契约所保留的意图驱动激活。显式 `sessions.open` 经 `session.activate` 发布活跃 Agent,恢复后台任务、定时与计划评审流程断言的打开契约,而启动恢复与窗格聚焦保持冷态;重连只重新发布用户显式打开过的会话,重启 e2e 因此仍能观测到挂接基线。

## Verification

`api-proxy-collaboration.spec.ts` 断言 mux 流对带 seed 的恢复先产出 `session/event(session/end-seed, seq 1)` 再产出 `session/subscribed(lastSeq 1)`。`api-proxy-models.spec.ts` 与 `api-proxy-cold.spec.ts` 覆盖 detached 选择分层与归属栅栏(48 个用例)。`service.client.spec.ts` 钉住契约:`/` 源不再注册 `warm` 钩子,首个 `candidates` 拉取对每个会话键只取一次。web 端到端规格保留 `historyCalls === 1` 与呈现后无 Agent 断言;显式打开套件经 `session.activate` 轮询活跃 Agent,`server-restart.e2e.ts` 覆盖重连重发布,`session-api.client.spec.ts` 验证 `sessions.activate` 路由到所属 runtime。

## Related

[end-seed 日志边界](../architecture/2026-07-30-session-end-seed-log-boundary.zh.md)设计了本修复所回放的标记;[会话历史与事件传输](../architecture/2026-08-18-session-history-and-event-transport.zh.md)持有本次发布所补全的基线协议。
