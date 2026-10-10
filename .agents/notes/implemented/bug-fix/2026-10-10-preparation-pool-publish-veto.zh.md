# Agent Note: 准备池发布闸误伤缓存冷读

Status: implemented

[English](2026-10-10-preparation-pool-publish-veto.md) | 中文

## 问题

只要池中存在同 id 条目,`SessionPreparations.reservationFor` 就拒绝一切同 id `Session` 发布——除非发布对象恰好是被保留的那个 `Session`,否则抛出 `cannot publish session: persisted state already owns this identity`。在 coordinator 后端(SQLite、gateway)上,`inspect()`、经 `inspectStored` 的 `open()` 以及每条读路径都会在池的 LRU 里留下 `ready` 条目,于是一次普通只读就永久毒化了该 id 后续的 `sessions.create()` 与 resume 发布;唯一的出口是 `appendCore` 驱动的 `invalidate`、LRU 淘汰或进程重启。经由 `persistence.open(id, 'write')` + `sessions.prepare` 的 Agent resume 发布的对象与池中任何对象都不同,所以当并发的 `inspect`/`load`/`prepare` 在 resume 的失效化 append 与其发布之间重新播下条目时,闸门会在一条合法流程上开火——而被拒的发布不会移除该条目,重试会持续失败。该 resume 路径没有任何集成覆盖,因为全部 agent-loop resume 用例都跑在 JSONL 后端上,而 JSONL 从不经过 `PersistenceCoordinator`。

## 决策

只有被持有的 `reserved` 条目才拥有未发布身份。`reservationFor` 现在丢弃 `loading`、`ready` 与 `committing` 条目并返回 `undefined`,让发布继续走 `onCreated`/`adoptLivePrefix`——那里的 `seedCoversPrefix`、`cwd` 与 `inheritedEventCount` 校验仍是权威的碰撞仲裁。`reserved` 配上不同 `Session` 对象仍然抛错——准备持有者发布精确对象是唯一的真别名冲突。每个被挤出的等待者经由池中既有机制收敛:`reserve()` 在条目被移除时返回 `undefined`,`prepare()` 因此重试进 `while it is live` 拒绝;`inspect()` 复查 store 并返回 `inspectLive`;共享的 `entry.result` deferred 对排队观察者仍正常兑现或拒绝。

`prepareCore` 在其 detached `Session` 铸造边界处用 `SessionAlreadyExistsError` 拒绝在读取期间转为 live 的 id;该错误绕过 corruption 包装原样抛出,因为 live 身份冲突不是数据损坏。`load()`、`prepare()` 与 `inspect()` 转换这一拒绝:`load()` 返回 `loadLiveSnapshot`(id 已离开时重试),`prepare()` 重抛确定性的 `while it is live` 冲突,`inspect()` 重试或返回 `inspectLive`。abort 仍优先于该转换。

## 备选方案

**保留 `loading`/`committing` 的闸门,只对 `ready` 放行。** 否决:它只是缩小窗口,持有写句柄的合法发布者与在途冷读竞争时仍会崩溃;而且被拒的发布仍留下条目让后续发布继续失败——正是 bug 会扩散的那一半。

**让 agent-loop resume 通过 `persistence.prepare()` 发布池中精确对象。** 否决:open-handle resume 是同样合法的备用路径,其发布经 `adoptLivePrefix` 自校验;过宽的是池闸门而非发布者。两种发布形态都保留。

## 后果

在冷读在途或已缓存的 id 上发布 `Session` 现在胜出而非崩溃;冷工作收敛到 live session。在途 `commitPrepared` 仍先于发布者的串行化 adopt 落盘,认领已修复日志的 live session 仍须通过 `seedCoversPrefix` 覆盖它——真实的 id 碰撞仍以 `id collision` 失败。对有开放 turn 的 live session 调 `load()` 仍按设计以 live-turn 拒绝报错。`assertWritable` 仍在 `committing`/`reserved` 期间阻止冷 append,持久化修复绝不与写入交错。

## 验证

`preparations.spec` 覆盖 `ready` 放行(返回 `undefined`、条目被丢弃、后续 `reserve` 成功)、`loading` 与 `committing` 放行(等待者得到 `undefined`),以及保留的 `reserved` 异对象拒绝。`persistence.spec` 端到端覆盖在检查缓存条目上发布、live 发布胜过被门控的在途冷 `load`(load 收敛为 live-turn 拒绝),以及与退役竞争的发布——其空 seed 仍因 `id collision` 在 adopt 时失败且存储不受影响。`became-live` mock 套件钉住 `prepare`/`load`/`inspect` 向 live 视图或冲突的转换。
