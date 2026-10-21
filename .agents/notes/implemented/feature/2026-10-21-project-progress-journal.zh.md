# Agent Note: 项目进展纪要——面向人的共享活动 AI 梳理

Status: implemented

[English](2026-10-21-project-progress-journal.md) | 中文

## 问题

[项目动态](2026-10-17-project-activity-feed.zh.md) 逐行回答「谁说了什么、选了什么」，但离开一阵回来的成员仍要翻原始记录才能知道项目定了什么、完成了什么、卡在哪。需求是一份人读的梳理——「让成员不读聊天记录也能拿到近期变化」——带两条硬边界：无事发生时不许空转（不做周期性空梳理）；它是**面向人的纪要，不是 agent 记忆**——harness 的记忆系统成熟且独立；纪要可以读成员可见的素材，但 agent 不消费纪要，纪要也不进入记忆域。

## 决定

新增**项目进展纪要**：Gateway Postgres 侧一个事件门控的 AI 梳理 pass，把共享可见的成员活动折叠成持久化纪要条目，加上 `ui-project-activity` 面板的 `progress` 档——第一档、默认视图。

### 存储：迁移 059

- `harness.project_journal`：条目。`kind='current'` 是滚动覆写的「项目现在到哪了」行（部分唯一索引，每项目一行，每次 pass upsert）；`kind='period'` 行携带 ISO 周 `period_key`（`YYYY-Www`）、结构化 `content`（`summary` 加 `定了`/`完成`/`进行中`/`卡点` 四节，节内条目署名 `{ text, actor?, sessionId, sessionTitle, seq? }`）、`activity_count`、素材周期边界与解析出的 `model` 路由。
- `harness.project_journal_state`：每项目 pass 状态——已提交水位线（`watermark_ts`、`watermark_session`、`watermark_seq`，与 feed keyset 同序）、`last_run_at`、`generating_since`（在途租约）、`last_error`。

### 素材：仅成员可见

一次 pass 从 `visible` CTE 读取——要求组织/项目归属、根会话、未删除、`visibility='project'`，与 `listConversations` 同一归属边界。成员私有会话不可能进入项目级纪要。边界内收集成员 `user/message` 行（feed 的 `source.kind='user'` 口径）与带答案数组的 `question` 交互响应——选中答案即决策——再把行折成编号素材行（`[n] 时间 · 人 · 会话 · 说了/定了: 内容`）进提示词。会话标题取 `harness.human_session_title` 加首条人类行兜底。行数有界（`maxMaterialRows`、`maxAssistantRows`、`maxItemsPerSection`），素材限于 `materialWindowDays` 窗口。真实事件负载可能含 `\u0000` JSON 转义（粘贴的二进制内容、工具变更 scope）；Postgres `json` 导航会解码该转义并使整条查询中止，因此所有 `event->`/`event->>` 访问都先经 `SAFE_EVENT` CASE 守卫在文本层跳过这些行，再做 JSON 导航。

### 触发：三道门，绝不定时空跑

服务以短的 unref 间隔（`sweepMs`）扫候选项目，但只有三门全过才启动 pass：

1. **活动门**——水位后至少 `minActivity` 条新行；一条新决策（`hasDecision`）即可降阈。
2. **静默门**——最新活动已过去 `idleMs`，工作一阵收口后梳理，不在流中打断。
3. **间隔门**——距上次已提交 pass 至少 `intervalMs`。

数周静默不产生候选事件，因此零模型调用。`POST /account/api/progress/generate` 绕过门控供成员强制梳理。水位线持久化在 Postgres，重启后从上次提交处继续。

### Pass：单飞、只在成功时提交

`acquire()` 以一条原子条件 upsert（`ON CONFLICT … DO UPDATE … WHERE` 租约空闲或已陈旧）取 `generating_since` 租约，并发 sweep 与手动 pass 不会双重启动；超过 `leaseMs` 的陈旧租约被回收，崩溃的 pass 不会卡死项目。pass 从模型治理策略（`policyForProject`）解析默认路由、取组织托管凭据，再以编号引用提示词调用 chat-completions 端点。模型输出须校验：`定了/完成/进行中` 的每条必须带能解析到真实素材行的 `ref`（署名从行拷贝，不让模型杜撰），`blocked` 条目允许独立成立，解析不了的引用丢条目，既没有可用 summary 也没有有效条目的输出整轮拒绝。成功时一个事务写入 `current` upsert、`period` upsert 与水位线提交；失败的 pass 记录 `last_error`、水位不动，同样的行进入下一次 pass。无素材的 pass 释放租约、不虚构条目。手动梳理是异步的——HTTP 处理器返回 `{ started }` 后 pass 在后台跑——慢模型不会拖死请求。

### 客户端：`progress` 作为默认档

`ui-project-activity` 新增 `fetchProgress`/`generateProgress` 线路函数、`ActivityMode = 'progress' | ActivityGrouping`，以及渲染滚动当前摘要、折叠期次条目（最新默认展开）、节头、点击 `reveal` 源会话的署名 chip、生成说明行与报告 `pending` 未梳理行数加「立即梳理」动作的状态条的 `ProgressView`。store 默认 `grouping` 为 `'progress'`。页面报告 `generating` 期间 inject 面轮询纪要到落地——包括打开面板时已在途的 pass。路由返回 `400`/`404` 渲染为「功能未启用」页而非传输失败，未挂载服务的部署安静降级。

## 考虑过的替代方案

- **runtime 侧 curation pass 写记忆条目**（第一版设计草图）：否决。共享/私有边界的权威在 Gateway SQL（`conversation_*` 可见性）；runtime 折叠看不到 `visibility='project'`，有把私有会话泄进项目级产物的风险。Gateway 还已经持有模型路由与托管凭据通路。
- **纪要条目放进 agent 记忆域**：按需求否决。人读纪要与 agent 记忆保持两个域——记忆 catalog 永不列纪要条目，模型请求永不读它们。反向（梳理时参考记忆事实）留作开放未实现。
- **workspace 里的纪要文件或会话**：否决——文件跨期碎裂、会话把产物埋进聊天列表；专用存储保持面板渲染的「当前+期次」形态。
- **定时 pass**：否决——固定周期在静默周白烧 token；事件门控的 sweep 在无事发生时零调用。

## 后果

- 一次新增 Postgres 迁移、两条 account 路由、一个 `progress` 配置段（`HGW_PROGRESS*`）、一个 unref sweep 定时器、一个客户端档位。无 session 格式、模型请求或 runtime 变化；记忆域未动。
- token 成本受 `intervalMs` 与素材上限约束；`enabled: false` 时零调用。非 Postgres 部署不挂服务、显示不可用页。
- feed 早先对[模型侧召回的否决](2026-10-17-project-activity-feed.zh.md)仍然成立：纪要条目永不进入模型请求。本 note 是那个否决预期中的面向人的姊妹篇。

## 测试

- `gateway/tests/progress-service.spec.ts`（16 例）：ISO 周键、输出引用校验（含 blocked 独立成立例外）、不可用路由、空闲/陈旧/已占租约、活动/决策/静默/间隔门、成功写入加水位提交、记录 `last_error` 不动水位、提问加答案的决策折叠、共享可见素材口径。
- `packages/client/ui-project-activity` 单测（14）照旧覆盖分组与注册；`apps/web/tests/project-activity.e2e.ts` 增加进展路由 mock 并断言进展优先的默认视图再切到 feed。
- `apps/web/tests/project-progress.e2e.ts` 在 mock Gateway 上启动真实 Web 组合：纪要落地、期次折叠、署名 chip 跳源、强制 pass 从在途轮询到落地、以及无「立即梳理」入口的不可用态。
