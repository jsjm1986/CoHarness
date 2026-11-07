# Agent Note: 逐记录 JSON 引导在发布状态前恢复中断

Status: implemented

[English](2026-10-23-resumable-json-unit-bootstrap.md) | 中文

## Problem

legacy 整单元导入逐条写入记录。第一条之后的 I/O 失败会留下部分目录树，而常规的已有文档规则会阻止之后的 legacy 导入。因此成功重开可能漏掉仍被保留的 legacy 记录。

## Decision

[JSON 后端](../../../../packages/storage/storage-json/README.zh.md)在写入迁移元数据前验证所有已声明的 legacy 表和路径安全键。任何记录发布前，`.legacy-bootstrap.json` 以带版本的 `copying` 状态保存已接纳的来源文本。每次加载都恢复该快照，直到复制完所有已声明记录与 global 槽，再原子替换元数据为 `complete`。

完成标记会保留。删除已迁移记录不能使空树再次导入 legacy 文件。无效进度元数据或无效保留来源会拒绝加载，而不暴露部分状态。legacy 整单元文件保持不变。没有迁移元数据的树保留已有文档优先规则；旧实现留下的部分树不能与有意编辑安全区分。

## Alternatives considered

- **将第一条记录视为迁移完成。** 不采纳：中断的导入会静默漏掉后续记录。
- **每次加载都合并 legacy 记录。** 不采纳：已删除记录会复活，本地编辑可能被覆盖。
- **替换整个目标目录。** 不采纳：已有树可能包含无关文件；替换或删除它会扩大迁移所有权。

## Consequences

未完成导入会额外保留一份来源，并可重复写入记录直到完成。读取方得到完整导入状态或失败。逐记录版本接受规则、常规写入排序和已记录的后端目录 fsync 限制保持不变。

## Verification

[后端测试](../../../../packages/storage/storage-json/tests/json-backend.spec.ts)注入第二条记录发布失败，重开单元后要求两条记录与 global 值齐全，并验证之后的删除不会复活。无效元数据和不安全的 legacy 键在接纳部分状态前拒绝。
