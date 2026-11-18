# CoHarness → dsh-v0.2.2-rc.3 升级计划

## 状态、目标与证据

状态：`implementation-in-progress`(选择性吸收已逐批落地并独立复核;真实模型与外部环境验证按阻塞项登记)。本轮目标:在保留既有架构、安全、治理与产品决策的前提下,完成与上游 `dsh-v0.2.2-rc.3` 的发布级对齐。本轮采用**选择性 backport 吸收**而非 git merge:`dsh-v0.2.2-rc.3` 不在本分支祖先链中,4216 个上游提交的累计树差异按 416 个对齐矩阵行(adapt 293 / reject 80 / retain 43)裁决后逐批落地。

| 引用 | 固定值 | 用途 |
| --- | --- | --- |
| 累计比较基线 | `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` | 本轮累计差异起点;上一轮已实现并验收 |
| 本轮唯一目标 | `dsh-v0.2.2-rc.3` / `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` | 未实施部分直接采用此树的最终实现 |
| 本轮实施基线 | `459c70fef096481336e252065938f3a86c93a967` / `master` | 吸收工作起点(master 即合并基) |
| 中间发布 tag | `dsh-v0.2.2-alpha.2`(f3803c96974)、`alpha.3`(05b1cae8db6)、`rc.1`(66491b05e3f)、`rc.2`(ddac96760b6) | 均为 rc.3 的祖先,登记于清单 `targetTags` |
| 发布版本 | 暂拟 `0.2.2-rc.1.coharness.1` | release families 与生产版本核验后确定 |

[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.2-rc.3.json)记录决定与验证;[矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.2-rc.3.json)将 10544 个累计差异路径归入 416 行并逐行登记复核状态(全部 `implemented-local-tests-passing`);[提交清单](../alignment/UPSTREAM-COMMIT-INVENTORY-dsh-v0.2.2-rc.3.json)固定上游 4216 提交边界;[同步记录](../../scripts/upstream-sync.json)已固定 `syncedTag: dsh-v0.2.2-rc.3` / `38a6a5c965`。

## 已锁定的实施决策(已落地)

| 决策 | 落点 | 不可放宽的条件 |
| --- | --- | --- |
| 命名子代理与树寻址 | `72d5bf7e898` | `send_message`/`list_agents`/`wait_agent` 按 agent 名寻址;委派最终答复自动投递包装替换 parent-id 指引;`tool-subagent-control` 增 `interrupt` 配置,base patch 显式 `interrupt: false` 使普通子代理与 Team 不提供 `interrupt_agent` |
| executor 缝隙重构 | `0c19590cb4a`、`e2bd55d9a6a` | 工具调度拆为 `core/tools` 管线 + `tool-executor-native`/`tool-executor-ptc` 执行器;PTC 经 `ctx.subprocess` 缝隙沙箱执行,`process.env` 默认空 |
| Remote 事件经物理流复用转发 | `4dd14d1b1d2`、`2484e7e3167` | `user-questions/request` 与 `approval/request` 等 waterfall 事件可转发给 `answers` 能力的远端 Client;**零可应答投递立即 settle `next` 落回本地 provider**——fork 的浏览器走 mux 下行而非 typert remote-event Client,上游"滞留等待晚连接"语义在本组合下会饿死本地 provider(独立复核发现并修复) |
| Agent Teams v2 | `991f9b91094` | v2 落 `packages/team/*`;上游删除的 `experimental/agent-team` 系裁决为 reject,保留 fork 既有 experimental 副本 |
| forge 子系统 | `6c7be7e93f6`、`34862c2798c`、`a5326f23a94` | `forge` 注册表 + `forge-github` provider(经 `gh` runner argv,凭据归属 `gh auth`)+ `forge-session` 绑定 + `client-ui-forge` 面板 + `worktree`;上游 forge bundle 不携带(experimental opt-in,非出厂组合) |
| feedback 两包 | `38624f6ce40` → `713e0be5a08` | 移植后按 fork 决策整体回退;不携带 |
| deepseek-chat-import | 矩阵裁决 reject | 上游 rc.3 主线新增(发布合并主线父提交 `b8c33a15042`);账号/历史耦合面不携带 |
| sdk-run-commands | `bbc368d1405` | 移植到本地 server 架构 |
| 上游 client/api 自留包 | 矩阵裁决 reject(80 行) | `packages/client/ui-*`、`api/*-controller` 等上游自有层不携带;fork 的 `apps/web` + client 包体系与 BFF 为自有实现 |
| per-event projection frames | `d17e51d3f56` | session-projection 逐事件帧;web 客户端回放路径已验证 |
| 会话 ZIP 导出容错 | `d69350f0315` | 附件缺失不再中断导出 |
| str-replace-editor ToolArgsError 分类 | `366ff1cfbd4` | fs artifact manifest 落地;fork base patch 全局启用 `str_replace_editor`(上游为显式 opt-in,fork 有意差异) |
| 权限播种迁移 | 上游携带 | `permission/preset` 从 `session/created` 移到 `agent/created` 播种;裸 Session 不再有权限事实,测试以 `agents.create` 断言 |
| Web 搜索默认 provider | 上游携带 | 出厂组合默认 `searchProvider: deepseek-search-api`(fetch 仍 `http`);选择等于部署默认时 `select()` 清除项目覆盖而非写重复值 |
| setup 窗口 append 耐久性 | `0a42ffa1cc1` | rc.3 将 `setup` 移进已发布窗口后,setup 内 append 由同步 durable 降级为 write-behind;经 `ctx.sessions.flush` 屏障恢复 durable-at-return 契约(独立复核发现并修复) |

## 阶段执行与放行条件

| 阶段 | 范围 | 状态与证据 |
| --- | --- | --- |
| S1 | 特性移植批 | named-subagent/forge/sdk-run-commands/agent-team v2 落地;见上表 |
| S2 | sync 批 | runtime infra、llm generation、interaction、subprocess、cordis、tool、fs、session lifecycle、ptc-runtime、remote-events、projection frames、str-replace-editor、glue packs 逐批落地 |
| S3 | fork 消费者回归 | gateway/admin-ui/plugins/PG 套件全绿 |
| S4 | 全量单测与 expected | `pnpm run test` 全绿;失败逐条归因后修复或重录 |
| S5 | 构建、hygiene、文档、产物 | build/hygiene/doc-sync/release:pack 370 tarball + 380 安装验证通过 |
| S6 | Web 真实浏览器回归 | `test:web` 全量 **144 文件 / 559 测试全绿**(built 组合);发现的 3 个真实回归全部修复:remote-events 零投递饿死、setup append 写后降级、设置对话框 boot-race 测试缺陷 |
| S7 | 覆盖率门禁 | 进行中(ENOSPC 后串行重跑) |
| S8 | 语义审查 | 矩阵 416 行全部 `implemented-local-tests-passing`:高风险面逐一读 diff(executor 缝隙、session 宣告生命周期、sandbox 升级错误分类、webserver Resource 路由、forge argv/URL 校验),全部 pending src diff 凭据/出域/exec 风险扫描零命中 |
| S9 | 兼容性与回滚 | 格式层契约已验证:v2–v6 全代夹具在 HEAD 回放(162 份 v6 + 更早代际);HEAD 写出的 v7 在旧构建上由 `SessionFormatUnsupportedMigrationError` 明确拒绝(catalog.spec 锁定);SSH/PTC 本轮无协议协商面变化。**物理 master 构建双向演练未做**(资源约束),登记为缺口 |
| S10 | 真实 key 功能验证 | **阻塞**:见下节外部依赖 |
| S11 | 真实用户旅程 | **阻塞**:同上 |
| S12 | 平台矩阵与外部环境 | **阻塞**:harness.maycran.com 502;Windows 原生验证未在本轮执行 |

## 复核修复批次(独立审查发现并已落地)

- `2484e7e3167` remote-events waterfall 零可应答投递立即 delegate——上游缺陷在 fork 组合下显形(上游浏览器本身即 remote-event Client,fork 走旧 mux 下行);断连路径同因同修;gateway spec 15/15。
- `0a42ffa1cc1` apiproxy `session/created` 宣告内 append 经 `ctx.sessions.flush` 恢复 durable-at-return;同型全仓仅此一处;apiproxy 1039/1039。
- `4c9d1ffd837` llm-replay `childOverrideFiles` 显式子槽位绑定——`session/created` 宣告式绑定改变 replay 槽位语义后恢复子代理中断夹具确定性;llm-replay 120/120。
- `f3aa0483b53`/`cfd1242ec0b` 测试期望与出厂默认对齐:权限播种走 `agents.create`、Search API 默认开启、str_replace_editor 全局工具位、`+2 files` 产物计数、`typesafe` 目录过滤、50MiB 图片上限(上游调限)、委派投递包装文案;golden diff 逐一确认纯预期变更后刷新。
- `d53239c324f` 门禁归类修复:tool-testkit 重新归类、client-ui-forge web 组映射。
- 设置对话框测试缺陷:点击早于客户端水合即永久丢失——`settings-chrome` 加 frame 等待与轮询重试,全文件 12/12。
- 覆盖率两次 ENOSPC 归因后串行重跑;`tsc -p tsconfig.host.json` 在 8 并发门禁下 SIGABRT(堆耗尽),`--max-old-space-size=12288` 单跑通过。

## 外部依赖与登记缺口

1. **真实模型验证(S10/S11)阻塞**:仓库 `.env` 的 `DEEPSEEK_API_KEY` 已被 API 拒绝(401 invalid);`~/.dsh/.credentials.yaml` 中另一把 key 有效(`/models` 200)但账户余额为零(`402 Insufficient Balance`,含 `deepseek-flash`/`deepseek-v4-pro` 两个可用模型)。需要充值或提供有余额的 key;`.env` 的失效 key 同时建议替换。
2. **公网部署验证(S12)阻塞**:`https://harness.maycran.com/` 返回 502,需要重新部署后验收。
3. **物理回滚演练缺口**:master 构建需要独立 worktree + install + build(磁盘约束未执行);格式层拒绝契约已有测试锁定,物理双向演练登记待补。
4. **Windows 原生验证**:本轮未执行;持久目标见 ACCEPTANCE-RUNBOOK。

## 收尾放行条件

- 矩阵 416 行 `implemented-local-tests-passing`(已完成);
- `test:web` 全绿(已完成,144/559);
- `test:coverage:partitioned` 通过(进行中);
- S10–S12 阻塞项由仓库 owner 解决后按 ACCEPTANCE-RUNBOOK 留证;
- 本文件与清单、矩阵、Agent Notes、双语配对同步收敛。
