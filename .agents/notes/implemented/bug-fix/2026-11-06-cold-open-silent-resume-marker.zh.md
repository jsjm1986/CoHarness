# Agent Note: 启动读取不再与静默 resume 标记竞争

Status: implemented

[English](2026-11-06-cold-open-silent-resume-marker.md) | 中文

## Problem

打开已保存会话会发出两次 `/api/session.history`:detached 预读在会话挂接前完成,`Session` 构造器随后追加 `session/end-seed` —— 一个在 store 条目建立前就已提交的持久事件,因此没有任何 `session/event` 观察者见过它 —— 而 `session/subscribed` 基线报告的 `session.seq - 1` 越过了客户端窗口尾,迫使 `repairGap` 为这一个标记重拉相同的历史页。同一打开流程还在用户不知情时恢复了 Agent:`sessions.models` 仅为填充选择器就调用 `agentFor`,于是一次只读的目录加载冷恢复了会话、追加了标记,并凭空造出一个活跃 Agent。

## Decision

mux 的 `session/created` 发布把构造期静默后缀 —— `session.firstLiveSeq` 及其之后的全部持久事件 —— 作为普通 `session/event` 帧先下发,再推送 `session/subscribed` 基线。已打开的客户端窗口以 `tail + 1` 实时缝合该标记,基线落地时已被覆盖,不再触发 gap 修复。对早于流存在的会话,初始基线本就包含该标记;新建会话没有可回放的后缀。

`sessions.models` 对 Agent 既不活跃也未在恢复中的会话,直接由持久日志作答而不再走 `agentFor`:`detachedSelection` 用 `modelSelectionProjectionDefinition` 折叠事件得到 pending 层、用 `foldRequestHeader` 得到已记录的请求头层,完整镜像 `selectionFor` 的分层,包括省略 adapter 默认推理档位的规则。subagent 归属栅栏先于所有分支执行,与 `agentFor` 的顺序一致;已在途的恢复仍然被汇入。

## Alternatives considered

**在基线中报告页内口径的 `lastSeq`。** `session.seq` 是连续日志长度且每个序号都是真实事件 —— 标记也不例外 —— 不存在"被过滤"的口径;低报它会把一次持久追加对投影隐藏。

**把 gap 修复推迟到 live 事件到达之后。** 这只是掩盖表象:标记仍是持久的且仍不在流中,重连或迟到的 open 之后还会撞上同样的重拉。

**`sessions.models` 保留 `agentFor`,只回放标记。** 它能修掉历史读数,但仍为一次持久日志本可作答的读取恢复了 Agent,违反"打开已保存会话不产生 Agent"的启动契约。

## Consequences

启动自动选择端到端断言 `historyCalls === 1` 在慢速 CI 时序下成立;同规格中 `ctx.agents.get(id) === undefined` 也成立,因为打开已保存会话不再为模型选择器恢复 Agent。任何其他构造期静默追加 —— 不只 `session/end-seed` —— 都由同一循环回放,而真实缺失的历史仍按原样走 `mergeTail` 修复。`sessions.models` 对冷会话不再执行 live SSH 准入;读取仍由授权门控。

## Verification

`api-proxy-collaboration.spec.ts` 断言 mux 流对带 seed 的恢复先产出 `session/event(session/end-seed, seq 1)` 再产出 `session/subscribed(lastSeq 1)`。`api-proxy-models.spec.ts` 与 `api-proxy-cold.spec.ts` 覆盖 detached 选择分层与归属栅栏(48 个用例)。web 端到端规格保留 `historyCalls === 1` 与无 Agent 断言不变。

## Related

[end-seed 日志边界](../architecture/2026-07-30-session-end-seed-log-boundary.zh.md)设计了本修复所回放的标记;[会话历史与事件传输](../architecture/2026-08-18-session-history-and-event-transport.zh.md)持有本次发布所补全的基线协议。
