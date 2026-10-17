# CoHarness → dsh-v0.2.1-rc.2 升级计划

## 状态、目标与证据

状态：`implementation-in-progress`(主体迁移已完成并逐批落地;收尾缺口按 defer 决策行登记)。本轮目标:在保留既有架构、安全、治理与产品决策的前提下,完成与上游 `dsh-v0.2.1-rc.2` 的发布级对齐。0.2.1 全部中间 tag(alpha.1–alpha.5、rc.1)均为 rc.2 的线性祖先,直接以 rc.2 为唯一目标;中间 tag 仅登记在清单 `targetTags` 中。

| 引用 | 固定值 | 用途 |
| --- | --- | --- |
| 累计比较基线 | `dsh-v0.2.0-rc.1` / `4878cdabd87d4041bdaff61d04c966883b9fd07a` | 本轮累计差异起点;上一轮已实现并验收 |
| 本轮唯一目标 | `dsh-v0.2.1-rc.2` / `687f282e8625c6b8d11ff58211a90524be2e4317` | 未实施部分直接采用此树的最终实现 |
| 本轮实施基线 | `8cb2cf1d3459d6fb121915c6b2e3375eef684af9` / `feat/upstream-sync-batch2` | 新候选必须取得自己的验证证据 |
| 发布版本 | 暂拟 `0.2.1-rc.2.coharness.1` | release families 与生产版本核验后确定 |

[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json)记录决定与阶段;[矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.1-rc.2.json)记录 9323 个累计差异路径的 395 个唯一 area、30 条 gate replay 复审;[发行说明台账](../alignment/UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-rc.1.md)登记 rc.1/rc.2 逐条裁决。[同步记录](../../scripts/upstream-sync.json)已固定 rc.2 源码比较目标;主权门禁输出为 63 tracked、219 adapted、46 owned(含 1 个 `upstreamShadowed`)、2 replaced、57 upstreamOnly。

## 已锁定的实施决策(已落地)

| 决策 | 落点 | 不可放宽的条件 |
| --- | --- | --- |
| preset 双包迁移 | `8a6aa525882` | `agent-presets`→`agent-preset`+`agent-preset-registry`;声明式注册层叠在 fork 文件发现/authoring/inventory 核心之上;`agent-presets` settings 命名空间不变(持久化用户键);declared preset 无 `path`,`FileAgentPreset` 收窄纯文件操作 |
| 运行时不变量移除 | `b569ce4f87e` | 跟随上游 `f028f25667d`:44 个 `src/invariant.ts` 伴生与全部 verify 门禁拆除;补偿性 spec 按上游 `96371534` 范式保留 |
| subagent catalog 外部执行 | `c73e7e911de` | 版本化叶条目;不迁统一激活面;外部可续接 Team 成员为 fork 独有能力 |
| remote-access 概念移植 | `95e354ad9ef` | 概念并入 `collaboration.authorize` 接缝;不做 controller 拆分;`api/remote-access` 记 upstreamOnly |
| ssh-helper-runtime | `079462b5208` | `kind:'node-script'|'embedded'` 判别联合 + pkg SEA;远端免 Node 收窄已记录 |
| DeepSeek Search/Fetch API | `a410ac34995` | `web/web-deepseek-api` 移植 + 实时 provider 开关 |
| claude-code-mods 抽取 | `10cff3fb193` | `dsh-client-store`→`dsh-client-runtime/client` 重映射;同族 11 个 experimental 包按命名阻塞项 defer(见抽取 note) |
| upgrade-guide 裁决 | `cb4fc43d05b` | 五篇上游指南不发布:对应行为未携带,指南只能描述已承载行为 |

## 阶段执行与放行条件

| 阶段 | 范围 | 状态与证据 |
| --- | --- | --- |
| E1–E8a | DeepSeek Search/Fetch、client 面、workspace/settings 对齐、remote-access 概念 | 已落地并逐批提交 |
| E9 | 运行时不变量移除 | `b569ce4f87e`;host/client 聚合构建全绿,140 门通过 |
| E10 | preset P5 双包迁移 | `8a6aa525882`;registry 181 tests + declared spec 7 tests 全绿 |
| E11 | upgrade-guide 裁决回填 | `cb4fc43d05b`;五篇不适用指南裁决登记 |
| E12 | 台账收口 | rc.2 矩阵生成(395 行/9323 路径/30 replay 复审);`syncedTag` 推进;主权门禁与升级记录门禁全绿 |

## 收尾缺口(收口结果)

1. `schedule/tool-schedule` 声明入 preset — **已落地** `3bd8b04bf09`:模型面四工具拆为 `dsh-tool-schedule` Consumer,standard/cordis/ptc preset 声明于 tool-jobs 后,schedule-bundle 仍为 Host 服务 opt-in。
2. python 主运行时 alias 校验 — **已落地** `9f835754a02`:`primaryRuntimePythonAliases`/`copyPrimaryRuntime` + smoke 拒绝展开命令文件。
3. bundled NumPy/pandas 测试套件剔除 — **已落地** `9f835754a02`:`prunePrimaryRuntimePythonTests` 在 wheel 解包后剔除 `tests/` 目录并重写 RECORD;payload digest format→7。
4. subpath plugin display-manifest 语义深度核对 — **已承载**:`app-boot/package-meta.ts` 与上游逐字节一致(仅 package-root 读 package.json,subpath 仅靠 `<specifier>/icon`),spec 100 测覆盖;指南三件套已回填。
5. `ui-plugin-market` policy/violation 复查 — **通过**:parse/index-url/types/search/tools/worker/parse-thread 与 `util/plugin-market-index` 全部与上游逐字节一致,后续上游修复(源码仓字段、Installed tab、generator commander)均已吸收;仅余刻意分歧——settings 命名空间 `SettingsScope`(fork settings 治理)、`bundle.optional`(fork optional-bundle 模型)、自有图标命名、`dsh-client-runtime` store 导入。`client/ui-secret-mask` **维持 defer**:依赖上游拆分版 `ui-conversation` 的 UserText rule lane,fork 刻意保留整合版 conversation(`removedUpstreamPaths` 已登记);本轮无 GUI 可见变更,GIF/PR 不触发。

## 范围和变更纪律

沿用 rc.1 计划的产品定位与纪律:`host/apiproxy` 唯一 BFF、`client/runtime` 唯一客户端会话状态源、settings 治理与 session v6 格式为主权;Session JSONL 代次不可变;SQLite `SCHEMA_VERSION` 单调;公共 API 变化同步全部消费者与双 SDK;上游桌面/账号/遥测/语音车道继续不携带。排除不等于不审查:被排除包内夹带的共享面修复仍须核对到本地方。

## 风险单列

- `experimental/` 迁位:上游 rc.2 将 10 个包移入 `experimental/`(hook-protocol、hooks-claude-code、hooks-codex、tool-terminal、tool-ralph、tool-session-query、session-title-all-prompts-llm、skill-badge、webhook、webhook-github);fork 保留自身分组路径,经 `upstreamOnly.replacedBy` 反向映射,不追随路径改名——下次同步须复核映射无漂移。
- 主权翻转:8 个原记 `owned` 的包经核证为上游同源移植(plugin-market 四件、harness-dev-context、web-deepseek-api、working-directory 两件),已改 `adapted`;`session-format-v3-to-v4` 维持 owned+`upstreamShadowed`。
