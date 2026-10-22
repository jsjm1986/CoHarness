# Agent Note: `dsh plugin` 只在转发的 pnpm 参数之前读取 `--profile`

Status: implemented

[English](2026-10-18-plugin-option-placement.md) | 中文

## 问题

`dsh plugin` 把剩余参数原样转发给 profile 插件目录里的 pnpm。fork 的解析器沿用 Commander 的默认选项处理：`plugin --profile <name>` 是子命令上的必需选项，但 Commander 会在命令行的任意位置继续消费 `--profile`（以及 `-h`/`--help`）——包括操作者本意是 pnpm 输入的部分。`dsh plugin add <pkg> --profile x` 会静默地把一个 pnpm 标志重新解释为转发器自己的选项，`dsh plugin --profile tui add --help` 打印的是转发器的帮助而不是去问 pnpm。哪些标志属于转发器、哪些属于 pnpm 与位置无关，因此无法可靠地写出「转发这个标志」的拼法。

上游 v0.2.1-alpha.1 升级指南（`plugin-option-placement`）用另一种方式消除歧义：转发器只在第一个被转发参数之前读取自己的选项，之后的一切原样放行。fork 如何在采用该契约的同时不丢失子命令自身的帮助？

## 决定

`apps/cli/src/args.ts` 按上游原样给 `plugin` 子命令加上 Commander 的透传语义：

- `.helpOption('-h, --help', 'show this help')` 在转发器自身恢复帮助标志——否则启动器禁用的 help 选项会被复制进子命令，`dsh plugin --help` 将不可用。
- `.passThroughOptions()` 在转发的位置参数开始后停止选项消费，因此边界之后的每个 token——包括 `--help`、`-h` 和 `--profile`——都原样到达 pnpm。
- `.requiredOption('--profile <name>')` 保持在边界之前的位置：只在 Commander 仍在消费转发器选项时读取，这正是所有文档与 smoke 脚本已经在用的「profile 在前、pnpm 参数在后」写法。

## 备选方案

- **保留位置无关的解析**——否决：pnpm 参数中的 `--profile` 或 `--help` 会被静默吞掉而不是转发，且根本没有办法写出「原样转发这个 token」。
- **要求以 `--` 作显式边界**——否决：上游选择位置透传，`dsh plugin --profile x add pkg` 无需分隔符；另选边界会破坏升级指南的契约以及所有已经写对的调用。
- **用其他标记区分 pnpm 参数与转发器选项**——同理否决：除「第一个被转发参数」之外的任何边界都与所采用的契约矛盾。

## 影响

该契约有意的破坏性变化：`dsh plugin add <pkg> --profile <name>` 与 `dsh plugin --filter x add --profile y`——过去都能选中 profile——现在会把 `--profile` 转发给 pnpm，并因转发器的必需选项校验而失败。把 `--profile` 放在 pnpm 参数之后的脚本必须把它移到参数之前；仓库文档与 smoke 调用早已使用正确顺序（`dsh plugin --profile sdk add file:<plugin>`），树内调用方无需修改。被转发参数之后的 `--help` 现在到达 pnpm，而不是转发器。

## 验证

- `pnpm vitest run apps/cli/tests/args.spec.ts`——58 个测试通过，覆盖边界后转发的 `--help`/`-h`/`--profile`、原样转发的 pnpm 前导选项、两种后置 `--profile` 写法失败，以及 `plugin --help` 各变体打印转发器帮助。
