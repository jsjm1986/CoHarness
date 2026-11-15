# Agent Note：llm-replay 把 per-child override sidecar 绑进子脚本槽位

状态：implemented

[English](2026-11-15-llm-replay-child-override-slots.md) | 中文

## 问题

`installLlmReplay` 按位置绑定脚本：槽位 0 是 primary fixture（叠加 `overrideFile`），`session/created` 把 subagent 子代宣告进后面的 child 槽位。`subagent-interrupt-ui.e2e.ts` 需要相反布局：子代经脚本化 `hang` 条目挂住 turn，父代的单次 prompted turn 回放一条录制调用。whole-script override 过去只存在于 primary 槽位，于是子代的 `hang` 脚本停在 slot 0，被未宣告的父代先抢走——父代吃掉 hang、turn 永不结束，子代却绑到了父代的单调用 fixture。上游同一测试能过是因为其绑定纯按调用序、子代恰好先调模型；fork 的宣告式绑定（命名代理把 session id 移出工具结果后必须如此）使这种倒置成为必然。

## 决定

`ReplayConfig.childOverrideFiles` 与 `childFiles` 平行索引：`childOverrideFiles[i]` 对子槽位 `i` 应用与 `overrideFile` 相同的 `ReplayOverrideDoc` 语义——裸 `ReplayEntry[]` 整体替换该子代的派生脚本，`{ patches }` 在其上按索引替换。共享的 `applyOverrideDoc` 同时服务两条路径。web scaffold 以 `replayChildOverrideFiles` 透传。该测试改为诚实接线：`replayFixture` 放父代录制 turn（primary 槽位），`replayChildFixtures` 放仅用于排序的最小 child shell，六条目脚本经 `replayChildOverrideFiles` 进入子代的宣告槽位——不再依赖谁先调用模型。

## 备选

- **在调用时把子代注册进下一个未占槽位**——能为该测试复现上游调用序，但放弃子代先于父代首次调用时的一切确定性绑定；后续父代 turn 里的 `{{session:N}}` 物化要求子代槽位在该调用前已固定。
- **在 child JSONL 里表达 `hang`**——`hang`/`throw` 按设计只属 override 词汇；录制流无法表示被刻意挂住的 turn。

## 后果

嵌套代理场景现在可以脚本化子代侧的挂起与注入失败，无需倒置槽位顺序。其他场景的宣告式绑定不变。上游同时更改了子代提示文案（`Your final answer is delivered automatically…` 取代 parent-id `send_message` 包装）；受影响的 e2e 断言与 aria goldens 在同一变更中更新为新包装。
