# 上游发布说明逐条对账 — dsh-v0.2.1-rc.1

## 范围与方法

- 输入：`dsh-v0.2.1-rc.1`(`1600d8a`,与 rc.1 时点的 upstream/master 同头）发布说明全部条目。rc.1 说明为 alpha.2→rc.1 周期累计汇总，与 alpha.4 台账重叠的条目沿用 [alpha.4 台账](UPSTREAM-RELEASE-NOTES-LEDGER-dsh-v0.2.1-alpha.4.md)判定。
- 证据:fork 与上游无 merge-base,按包级树对比 + 功能符号探测;四个并行审查覆盖 release/API/UI/包级缺口;每项判定经人工复核源码存在性。
- 本地基线:`feat/upstream-sync-batch2` 分支,含本周期落地提交 `d2b36fc`、`9e80447`、`94c1ed2`。

## 判定口径

| 代码 | 含义 |
|---|---|
| Y | 已有/本周期落地(注明提交) |
| N | 缺失(注明阻塞) |
| L | 有意分歧/待统一决策 |

## 本周期新落地(原 N → Y)

| 条目 | 落地提交 | 说明 |
|---|---|---|
| 参数生成序指引(bash/pwsh/fs schema + justification 语言条款) | `d2b36fc` | 上游 `4166dbd`;run_code 保留本地刻意的 code-first 参数序 |
| file-reference @ 富文本 prompt | `d2b36fc` | 上游终态 "Tokens prefixed with @…" 全文;57 场景快照刷新 |
| pi-ai 0.87.1 → 1.1.0 + Azure provider 更名 `azure` | `9e80447` | 上游 `d79f13a4d46`;tool 新增改内联 `tool_definition`;升级指南三件套已建 |
| 进程相关 prompt 值(checkout 路径/Web URL)迁运行时上下文 | `94c1ed2` | 上游 `36779dcf099`+`adfa92bca189`+`2b229d4c0e5`;新增 `context/harness-dev-context`、`webApp.getAdvertisedUrl()`、`WebServer.bindUrlHost()/getOrigin()`;HMR 文案保留本地 `DSH_CLIENT_HMR=1` 语义 |
| 嵌套 presentationMeta + `tool/ptc-dispatch` 事件 meta 持久化 | `b17eb0f` | 上游 `c7e62c1`/`839bd51`/`d6adc5d` 语义增量 |
| cordis-plugin-development skill 全量同步 | `104e525` | practices.md/user-actions.md 等 8 个文档提交终态 |
| package-meta icon/SVG 门禁 + 嵌套包资源检查 | `9156742` | display-resources 测试合并 |

## 确认已落地(Y)

Session plugin 记录(#5677)、持久 PTC(#5035)、subagent Agent Presets(#4643)、pi-ai 会话内 system prompt/动态工具(#4934)、共享 agents 目录 + `DSH_AGENTS_HOME`(#5693)、麦克风选择(#5729)、SDK resume(#5988)、字体设置(#5328)、both 模式移除(#5800)、subagent 图片粘贴恢复(#5866)、Office 渐进指引、`working_directory` 工具、`--public-url`、`--tls-cert/--tls-key`、`engines.dsh`、subagent 立即返回 child ID + `session/wait`、Markdown frontmatter 字段列表(`ui-workbench/frontmatter-fields`)、插件自定义索引源(`plugin-market`)。

## 缺失(N)

| 条目 | 缺失面 | 阻塞/备注 |
|---|---|---|
| SSH 独立 helper 运行时 | `ssh/ssh-helper-runtime` + `build-exe-for-ssh-helper.yml`/`publish-ssh-helper.yml` | 需将 `LaunchConfig` 改回上游 `kind:'node-script'|'embedded'` 判别联合(反转 #5035 本地扁平化);发布工作流是否纳入 fork 管线属决策项 |
| API 按调用方授权/连接管理 | `api/*-controller`(7)、`api/remote-access`、`api/workspace-files` | 与本地 `host/apiproxy`+`gateway-*` 架构相交,依赖决策项 3 |
| Claude Code Mods 兼容层 | `experimental/claude-code-mods`、`client-ui-claude-code-mods` | 实验包,待取舍 |
| 思考翻译插件 | `experimental/translator`、`cot-translation-bundle`、`client-ui-cot-translation` | 实验包,待取舍 |
| Git Worktrees 插件 | `experimental/tool-worktree`、`worktree` | 实验包,待取舍 |
| DevTools 组合包 | `experimental/{inspector,inspector-profile,session-inspector,session-search,session-titles-bundle,terminal-bundle,ralph-bundle}` | 上游内部实验基建 |
| DeepSeek 账号登录 | `credentials/deepseek-account`、`deepseek-account-platform`、`llm/llm-deepseek-account` | 产品策略相关 |
| Automation 内建 Web + 模式限定提醒 | `schedule/tool-schedule` | 本地 `schedule/schedule` 直挂 reminder,无模式限定 |
| 发送消息密钥脱敏 | `client/ui-secret-mask` | UI 重组后需按功能核接入点 |
| 其余 | `boot/config-editor`、`telemetry/otel`、`host/product-telemetry-otel`、`experimental/{cua,cua-macos,badge-skill-bundle,webworker-packer,webworker-runtime}`、一批 `client/ui-*` 拆分包 | 多为上游内部实验基建 |

## 结构性分歧(待统一决策)

1. `runtime-diagnostics/invariants`:上游移除全部 `./invariant` 导出;本地保留且 `packages/AGENTS.md` 仍有 invariant 规则(产品诊断面)。
2. `agent-instructions` 的 `dshHome` 逐行配置:上游已删(改进程 `DSH_HOME` 解析);本地 `config.ts` 保留。
3. API 层:上游 `api/*-controller` 拆分 vs 本地 `apiproxy`/`gateway-*`;`remote-access` 移植依赖此项。
4. `preset/agent-preset` + `agent-preset-registry` 声明式包 vs 本地 `agent-presets` 文件发现模型。
5. #4394 subagent 架构分化。
6. UI 面未包级定位条目(Agent 创建插件入口、collapse 时机、插件启停依赖同步/热重载、会话 ID 复制、窄窗口布局):UI 审查 12 在场/4 分叉/3 缺失,逐项核对后归入 L 或 N。
