---
description: "用 git 工作树快照和文件工具编辑前后的整文件捕获汇总每个顶层轮次改动的文件，以 workspace/changes Session 事件宣告，并在 Session 释放和 Host 重启后仍提供摘要和逐文件对比；配置、仓库要求与覆盖规则。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

[English](README.md) | 中文

经过鉴权的归档所有者只在会话释放后调用 `removeStored()`，先删除该会话持有的不可变审阅目录，再删除日志。普通释放不会调用它。

## 概述

本插件汇总每个顶层轮次的改动文件，并保存其前后对比。Git 快照覆盖工作树，整文件捕获覆盖此范围之外的文件工具编辑。发布 `workspace/changes` 事件前，插件在 `DSH_HOME/workspace-reviews` 下提交不可变、归属明确 Session 的审阅记录。关闭 Session 或重启 Host 会删除临时数据，但保留历史审阅。Web 卡片打开该历史，普通预览仍读取当前文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

正式提供的 Web bundle 挂载本插件。在同一执行目标具备配套 `fs`、`subprocess` 提供方、`sessionProjections` 以及 git 可执行文件的组合中可以挂载它：

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `storageRoot` | `DSH_HOME/workspace-reviews` | 私有持久审阅目录；修改时须在写者停止的维护窗口内搬迁已有产物 |
| `maxReviewBytes` | `67108864` | 每份审阅的最大序列化字节数；同时约束读取、发布及执行前所需的空闲空间 |
| `timeoutMs` | `30000` | 单条 git 命令允许运行的毫秒数，超时则记录失败并停止本轮 |
| `outputMaxBytes` | `8388608` | 每条命令保留的 git 输出字节数，diff 列表更大时记录失败并停止本轮 |
| `maxFiles` | `500` | 单份摘要携带的最大文件数；`total` 仍报告完整数量 |
| `maxFileBytes` | `2097152` | 文件在文件工具编辑前后被捕获、或从快照读出做对比所允许的最大字节数；更大的文件不提供对比，其中在文件工具编辑前后被捕获的也不带行数 |
| `diffTimeoutMs` | `100` | 逐行对比允许运行的毫秒数，超时后退化为整文件替换 |

有工作目录且不是子代理来源的 Session 都会被记录；子代理 Session 不记录。快照通过私有 index 写入 Session 自己拥有的临时对象目录，仓库自己的对象库以只读 alternate 的方式挂接；仓库的 index、对象、工作树和 ref 保持不变，用户此前未提交的改动也不会进入摘要。Session 释放时删除该目录。工作目录内的嵌套仓库和 submodule 记录为 gitlink，其内部改动不会出现。不在任何 git 仓库内的工作目录不做快照。没有 git 时——或者 macOS 上只有 `/usr/bin/git` 的开发者工具桩程序时——同样定位不到仓库，插件记录一次日志。两种情况下摘要都只列下文所述的文件工具编辑，并以工作目录作为工作区；shell 的改动不会出现。

在 `write`、`edit` 或有修改作用的 `str_replace_editor` 调用运行之前，记录器把该路径上的文件复制到 Session 的临时目录，每轮每个路径只复制第一次，轮次结束时再复制一次；副本按其字节的 SHA-1 命名，相同内容只存一份。这一步不需要 git。快照覆盖到的路径保留 git 的行数；其余路径由副本提供，也就是匹配忽略模式的文件、仓库之外的文件，以及没有快照时的每一次文件工具编辑，行数来自两份副本的逐行对比，因此同一文件的重复编辑只计一次，文件工具编辑之后的 shell 改动也包含在内。轮次结束时内容没有变化的路径不会列出。超过 `maxFileBytes` 的副本不会保存：该文件列出时带 `oversized`，没有行数；两侧都这么大的路径同样列出，因为没读过的内容永远不能认定为没有改动。只差一个末尾换行的路径对比为两侧相同，而 git 仍会把那一行计入行数。`/tmp` 与平台临时目录下的文件被排除，除非它们位于仓库内。快照覆盖范围之外只通过 shell 命令做出的改动不会被记录。

SSH 工作区的 Git、私有索引与快照对象属于远端执行目标，文件捕获使用有界且校验版本的 `fs` 读取。发布公告前，完整对比会复制到 Host 拥有的持久存储中；后续远端编辑或记录器释放不能改变它。远端临时目录仍须在连接释放前清理，目标不可达时会报告清理失败。

每个文件保留记录时的 `path` 和用于排序的 `display` 标签。工作目录内的路径保持相对形式，目录外的标签可使用 `../`、`~` 或绝对路径。`await ctx.workspaceChanges.summary(sessionId, seq)` 通过存活记录器或有界持久事件读取解析公告；`diff(sessionId, seq, index, signal)` 返回原始文件下标对应的已保存文本 hunk、`binary` 或 `oversized` 结果。文本对比保留三行上下文，超时导致的整文件替换标记为 `coarse`。读取校验内容摘要、Session 归属及摘要与对比的下标关系；鉴权 RPC 另行复核 Session 和路径访问权。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个 Session 的 `TurnRecorder` 串行执行基线快照、文件工具捕获与轮次结束记录。Git 使用私有索引和对象目录，仓库对象库仅作为只读 alternate；用户此前未提交的改动不进入本轮 diff。记录器在发布前计算有界对比，写入并同步不可变产物，再将其内容身份追加到 Session 日志。持久审阅目录通过字面路径匹配排除在本机 Git 快照之外，已保存的审阅不会成为新的工作区改动。历史读取既不需要活动 Agent，也不读取当前文件内容。

Git 使用选定的 `subprocess` 提供方、净化环境、`GIT_CONFIG_COUNT=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、配置的超时与有界输出。记录或存储失败会追加不完整公告，停止受影响轮次，并阻止后续工作，直到新请求通过存储探测。已记录的容量需求必须满足新上限，文件系统必须能够容纳一份达到上限的审阅。已发生的文件效果不会回滚。在未结束轮次中更换记录器后，进一步执行被拒绝，直到新轮次捕获自己的基线。释放操作只删除临时 Git 对象和捕获，不删除持久审阅。

**运行时不变式：** 不发布伴生插件。产物读取在返回数据之前检查 Session 归属、内容摘要与文件下标关系；独立扫描会重复此准入检查，却没有观察另一个生产权威来源。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 产出物](../../client/ui-deliverables/README.zh.md)——读取所提供摘要并打开其文件的改动文件卡片。
- [子进程能力](../../subprocess/README.zh.md)——git 运行所经过的接缝。
- [本轮改动文件卡片决策](../../../.agents/notes/implemented/architecture/2026-09-23-authorized-workspace-review.zh.md)——快照设计、覆盖规则、暂缓的影子仓库与被否决的备选方案。


<a id="model-experience"></a>
## 模型体验

间接地，通过代理循环与工具流水线，记录失败会以已记录的错误停止执行。历史比较仅供客户端读取；本包不新增提示词或工具 schema。

#### KV Cache 影响

正常审阅数据不增加模型输入，已记录的录制错误可能改变后续错误上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 设置 `DSH_MANAGED_DATA_MANIFEST` 的受管启动会在写入数据前登记配置的持久审阅根；本机或 SSH 临时捕获目录不被认领。清单无效时拒绝初始化；保留旧根和部署批准遵循[清单与备份规则](../../util/managed-data/README.zh.md)。
- 持久审阅存储启用前产生的历史公告可能已无对应内容。UI 会显示历史不可用并提供读取重试，不会用当前文件重建过去的对比。
- 有两个 git 功能在快照期间仍会写入仓库自己的 git 目录：`core.splitIndex` 会写 `sharedindex.*` 文件，git-lfs 会对改动文件运行 clean 过滤器并把对象存到 `.git/lfs` 下。
- 需要 git 2.13 或更高版本以支持 `rev-parse --absolute-git-dir`；不支持的仓库格式或其他 git 失败会停止记录及受影响轮次，不会被当成普通目录。
- Session 的首次快照会把工作树里所有未跟踪且未被忽略的文件写进 Session 的临时目录；没有 `.gitignore` 却带着大体积构建产物的仓库，在 Session 释放前会占用同等的临时空间。
- 用户在轮次进行中自己做的编辑会被算到该轮。
- 不在任何 git 仓库内的工作目录只列文件工具的编辑，卡片里因此没有 shell 改动；Harness home 下的影子仓库暂缓，直到其排除规则能可靠地代替缺失的 `.gitignore`。
- 快照覆盖范围之外只捕获文件工具点名的路径：那里只被 shell 命令改动的文件不会出现，在首次文件工具调用之前被两者都改过的文件从该调用起开始对比。
- 每次文件工具编辑都会把整个文件复制一次，每轮每个路径一次，上限 `maxFileBytes`，即使快照也覆盖该路径；副本随 Session 的临时目录一起删除。
- 对比会把所列文件的完整文本送到客户端，包括被忽略的文件、工作目录之上的仓库文件和工作区外的文件；摘要路由只送路径和行数。必须把这类内容留在 Host 上的部署应把本插件组合出去。
- 退化为整文件替换的对比携带两侧的全部行，最多两倍 `maxFileBytes`。
- Windows 路径在 `path` 中保留原生分隔符；`display` 始终用斜杠分隔。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
