# 上游升级操作手册

[English](upstream-upgrade-playbook.md) | 中文

本手册定义 CoHarness 对齐上游 DSH 版本的重复执行流程，同时保留云端协作、Gateway 授权、Documents、Workbench、Android、native provider 和 vendor Cordis 的所有权。

## 两条变更轨道

产品变更和上游对齐使用不同的记录与评审路径。实现开始前就在 PR 中标明轨道。

- 产品轨道：由 CoHarness 所有的新功能或问题修复。新增运行时行为时使用 Cordis capability seam，并包含 Service Definition、Provider、Consumer、disposer、invariant、定向测试和 Agent Note。它不改变上游基线，也不能声称已经完成上游对齐。
- 上游轨道：针对一个确切的上游 tag 或提交进行比较。将升级 plan、manifest、alignment matrix、兼容性决定、迁移说明和验证证据放在一起。如果上游行为需要产品改动才能适配，并且两者可以独立评审，就把产品改动拆成后续的产品轨道 PR。

如果上游改动具有破坏性，上游轨道必须记录新旧公共类型、wire 字段、Session format 或持久化影响，以及所有需要迁移的 consumer。兼容 adapter 必须有 owner 和移除条件；不能借此永久保留两套 API。

这两条轨道是稳定的流程标签，不是固定的实现模板。一次升级可能只有兼容性修复，也可能包含大型迁移、纯依赖变化，或决定继续保留 CoHarness 现有行为。应由实际 diff 和业务影响决定工作内容，不要把每个 release 强行套进相同的代码修改顺序。

## 1. 固定基线

在阅读或修改代码前记录 CoHarness 提交、上游 tag 与提交、Node 和包管理器版本、发布族以及确切工作树状态。

从已核实的分支创建升级 worktree，并保持产品 worktree 不变。将未提交的产品改动保存为 patch，或提交到独立分支；不要把未知工作树与升级比较混在一起。

针对已核实的上游或发布基线运行 change-scope 报告。将 JSON 输出与升级记录一起保存，使后续 merge-forward 能区分原始范围和新合并的维护改动。

## 2. 建立对齐记录

每个行为或协议领域使用一行，而不是为每个上游提交或包建立一行。先完整阅读发布说明、compare range、提交清单、包清单、生成产物、vendor 变化、native 变化、测试和文档，再记录上游提交、CoHarness owner、本地等价实现、wire 影响、权限或数据出域影响、迁移影响、定向测试、外部证据和处置决定。

统一使用以下处置状态：

- retain：CoHarness owner 继续作为权威，上游代码不替换它。
- equivalent：行为已经存在，只补回归证据，不复制实现。
- adapt：在现有 CoHarness API、持久化、Gateway、ACL 或 UI owner 内采用上游行为。
- required：真实的正确性、安全、协议、迁移或性能缺口必须在发布前关闭。
- defer：这是新增产品能力，或需要独立业务决策。
- reject：改动违反云端、多 runtime、权限、数据出域或回滚边界。

不要把包名相似当作等价证据。必须在两侧追踪 producer、consumer、生命周期、持久化数据和模型可见结果。

记录格式可以标准化，记录里的决定不能标准化。某次 release 如果引入了之前矩阵没有覆盖的新责任，可以新增分类，并在 plan 中说明分类及其 owner，不要把它隐藏在相近标签下面。没有可信 CoHarness consumer 的分类可以记录为 deferred 或 rejected，不要为了填表创建占位实现。

## 3. 优先审计 Cordis seam

每个采用的能力都必须包含 Service Definition、Service Provider 和 Consumer。只有三个角色和其所有权都清楚时，Cordis 包才算完整。

核对 Host 和 Client 插件使用仓库当前的 inject、apply、effect 和事件约定。注册、listener、timer、stream、cache 和 HMR 状态必须返回 disposer，并在 session、principal、runtime generation 和 plugin 销毁时停止。

继续使用现有 api/remotes 合并点生成 Remote 声明。Host 和 Client 编译面、包 exports、catalog 生成、invariant、真实 Loader composition 测试以及所有 SDK 或外部插件 consumer 必须同步更新。

修改 vendor 源码前先比较 Cordis manifest。执行同步流程并以 exact edit 重新应用本地生命周期加固；不要用上游目录覆盖 vendor 目录。

## 4. 按依赖顺序处理破坏性更新

遇到破坏性公共类型或 wire 变化，先更新 Service Definition 和兼容性决定，再更新 Provider、Consumer、生成声明、SDK、ACP、Headless、snapshot 和文档。

遇到 Session 变化，保留相邻迁移边和 immutable generation 发布规则。迁移只有在重新校验源 fingerprint 后才能发布 successor，不能覆盖、删除或静默降级已提交的 predecessor。测试 torn tail、取消、并发写入、重启恢复和各 provider 的 fallback。

遇到模型可见变化，先更新 SessionEventMap 和可重放事件，再修改 prompt 或 UI。进入模型请求的值必须能从 durable log 重建，并一致投影到两个 SDK。

遇到 Gateway 或 ACL 变化，测试直接 API、备用 RPC 或 Web 路径、principal 过期、项目可见性、只读成员、撤权和 runtime generation 变化。根包测试不能证明独立 Gateway 项目正确。

## 5. 按影响选择证据

先运行覆盖变更 owner 的最小检查集，再对共享 seam 扩大范围。带版本的 `scripts/ci-scope-policy.json` 描述仓库当前已知的稳定 CI 影响域；升级决定仍必须检查实际 consumer，并且可能需要更宽的手动审计。只有新领域足够稳定、且 false-negative 与 false-positive 行为有证据时才增加策略项，否则使用 full 或 manual audit lane：

- 叶子包源码：owner 测试和变更源码 coverage；
- Session、Cordis、Typert、Gateway、LLM、子代理、sandbox、subprocess、terminal、vendor、native 或 client-connection：完整运行时和生成产物检查；
- 模型 prompt、skill、preset 或 Agent instructions：replay 或 snapshot 加 owner composition 测试；
- Client、Workbench 或浏览器行为：consumer build 和 browser snapshot；
- Gateway 代码：Gateway typecheck、build、unit test，以及环境可用时的 PostgreSQL ACL 测试；
- native 或进程隔离：对应的真实内核或平台 runner；
- 包、lockfile、build 或 release 改动：完整依赖、build、packed-install 和 release 验证。

发布候选或影响范围不确定时使用 manual full-audit workflow。不要降低 coverage 阈值，也不要屏蔽失败 lane 来让限定范围分类通过。

## 6. 分层合并和发布

将独立的维护、依赖、workflow 和 feature 改动放在不同 PR。对于 stack，核对确切 base 和 head SHA，并按 parent 到 child 合并；merge-forward 后重新运行 scope，并重跑受新基线影响的检查。

普通 PR 合并需要一个稳定的聚合状态。平台库存、nightly sweep、真实 API 检查和 release 打包保持独立，除非它们是该改动的 required 条件。只有分类器记录了其输入域确实不可达时，才接受 skipped lane。

发布前核对 release family、包版本、packed install、公网入口、生成 catalog、native companion 和 rollback artifact。发布使用不可变 packed bytes，并且是手动操作；dry run 不得修改 registry tag。

## 7. 收敛记录

在同一变更中更新 plan、manifest、alignment matrix、Agent Note、包 README 或 subsystem 页面、snapshot 和双语 pairing 记录。只有成功的 job 或外部验收记录才能替换 pending 证据；失败运行是失败证据，不是完成证据。

最终记录明确仍然 defer 或尚未完成外部核验的内容。只有 required 本地和 CI 检查通过、所有 required 外部环境有证据、部署回滚路径已演练，并记录当前版本和提交后，发布才算收口。

每次升级使用一套持久记录：plan 记录意图和取舍，manifest 记录确切提交与实现状态，alignment matrix 记录各领域证据。记录统一放在仓库的升级目录，并从 PR 链接过去。下一次升级从上一次发布提交开始，并引用之前的决定，不能覆盖决定。只有在仓库文档规则要求记录描述当前 owner 时，才更新过时路径或当前验证事实。

## 有意保持灵活的部分

不要统一规定每次升级的行数、优先级标签、提交分组、兼容 adapter 数量、迁移阶段或测试命令。这些选择取决于当次上游 diff 和当时的 CoHarness 业务拓扑。

统一的是问题清单：改了什么、谁拥有行为、哪些内容进入 wire 或模型请求、数据或权限如何变化、哪些已有等价实现、哪些明确保留、哪些延后、回滚可能在哪里失败，以及什么证据可以关闭决定。

## 8. 避免这些捷径

- 不要用上游包目录覆盖 CoHarness owner。
- 不要因为只改了一个文件，就把共享运行时 seam 分类为叶子包。
- 不要把 skipped test、cached artifact 或绿色 static check 当作 Gateway、native 或真实模型证据。
- 如果底层协议或错误约定应该保持兼容，不要直接更新 snapshot。
- 不要因为另一个平台通过，就合并红色 required job。
- 不要用本地模拟声称完成外部验收。
