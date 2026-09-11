# 上游同步与升级记录

[English](README.md) | 中文

所有上游对齐记录统一放在这里，并按文件职责分类。每次升级在这些目录中生成一组文件，使用 `<TYPE>-dsh-<version-or-tag>` 命名，使同一 release 的完整记录可以按前缀和版本查找。

| 目录 | 内容 |
| --- | --- |
| `plans/` | `UPGRADE-PLAN-dsh-*.md`——面向人的升级计划、逐项状态和本次同步的取舍记录。 |
| `manifests/` | `UPGRADE-MANIFEST-dsh-*.json`——机器可读的决策清单，包括上游/基线/实现提交、逐项状态、验证结果、备份 hash 和生产健康 id。 |
| `alignment/` | `UPSTREAM-ALIGNMENT-MATRIX-dsh-*.json`、`UPSTREAM-ALIGNMENT-PERFORMANCE-dsh-*.json`、`UPSTREAM-AUDIT-dsh-*.md`——逐项对齐证据、性能比较和审查报告。 |

规则：

- 新记录放入对应目录，沿用 `<TYPE>-dsh-<version>` 命名，不要创建新的顶层前缀。
- 目录之间使用仓库相对路径（例如 `upgrades/plans/…`），这样移动目录后链接仍然有效；plan 内部的交叉引用可以使用 `../alignment/…`。
- 描述已发布同步的记录作为该版本的真源；代码移动时更新事实（路径、名称、版本），不要改写已经作出的决定。
