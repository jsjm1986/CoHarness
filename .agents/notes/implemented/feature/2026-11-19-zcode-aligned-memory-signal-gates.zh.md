# Agent Note：对齐 ZCode 的记忆召回/提取信号门槛与辅助调用姿态

Status: implemented

[English](2026-11-19-zcode-aligned-memory-signal-gates.md) | 中文

## 问题

对 ZCode 记忆子系统（`memory/extraction.ts`、`memory/dream.ts`、`memory/recall/*`）的第二轮源码核实发现 DSH 移植版跳过了四个门槛与姿态细节：

- 召回对任何非空人类文本都发选择器；ZCode 要求至少两个词单位（裁剪后查询内含 `/\s/`），单字应答永不触发模型调用。
- 召回候选仅对已注入的 `memory-recall` 键去重；ZCode 还排除本会话中代理已完整读过的记忆（`findLatestReadFileState`）。
- 提取对任何含人类 `user/message` 的回合放行；ZCode 要求至少三个词的用户正文（`MINIMUM_USER_WORDS`）。
- 辅助请求沿用会话的完整模型选项；ZCode 把每次辅助调用钉在模型最低推理档位加 5,000 输出 token 上限（`auxiliaryModelOptions`），且召回内容对超过一天的条目携带陈旧提示。

## 决策

全部移植，并按类型化记忆服务适配：

- `dsh-memory` 的 `memorySignalWordCount` 是共享词代理：空白分隔词元加每个汉字各计一个单位。ZCode 仅按 `split(/\s+/)` 计拉丁词元，会把整句中文当一个词；逐字规则让 CJK 正文维持同等准入线。
- `memory-context` 在不足两个信号词时跳过选择器，并把 `memory_read` `tool/call` 事件折叠进 `read` 集合——代理已取过的条目无需再注入摘要。折叠按键名记，保守地连其他作用域的同名条目一并排除。
- `memory-curation` 仅在消息达到三个信号词时置 `sawHuman`。
- 每次辅助请求——召回选择器与两个整理循环——经 `llm.resolveModelInfo` 解析模型公开的最低推理档位，并把输出封顶到 `AUXILIARY_MAX_TOKENS`（5,000）。元数据查询失败只丢档位提示。
- `renderRecallEntry` 对更新超过一天的条目前置与 ZCode 内容渲染器一致的"N 天前"时点提示。

## 已考虑的替代方案

保留 harness 本地门槛——任何人类回合都触发提取、任何非空召回查询都调用选择器、辅助调用沿用完整模型选项。否决：ZCode 的门槛经过生产流量调优，放弃它们换来的只是更简单的代码和真实的召回/提取代价。也否决了为词数代理引入 CJK 分词器：逐字计数在不增加依赖的前提下维持同等准入线。

## 影响

单词回合与应答不再消耗选择器调用。已读过某记忆的代理不会再被注入其摘要。辅助调用走该路由公开的最便宜档位。ZCode 尚未移植的两个行为——粘性选择器会话与 dream 期的转录收割——维持刻意缺省：耐久键折叠已能跨压缩防止重选，逐回合提取已完成新信号收割，合并只需去重。

## 测试

七个新规格覆盖词门槛（拉丁、中文、混写、空）、已读排除（含畸形与非字符串调用参数）、effort/maxTokens 请求字段、假时钟下的陈旧提示、以及提取正文门槛。`packages/memory/` 全部套件以每文件 100% 覆盖通过。
