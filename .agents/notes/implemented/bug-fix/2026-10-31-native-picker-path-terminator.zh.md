# Agent Note: POSIX 原生选择器的路径终止符

Status: implemented

[English](2026-10-31-native-picker-path-terminator.md) | 中文

## 问题

POSIX 目录名可以以回车或换行结尾。从选择器输出中删去所有末尾换行符会改变所选文件系统路径，并可能指向其他目录。

## 决策

macOS、Zenity 和 KDialog 适配器移除命令作为输出终止符发出的一个 LF。此前的所有字符仍属于所选路径。空输出或仅含一个终止符表示取消。Windows COM 适配器直接返回路径，不使用此解码器。

这保留了[原生工作区交互](../feature/2026-07-27-native-workspace-directory-picker.zh.md)所需的目录身份，与其[客户端结果代际隔离](2026-09-16-native-picker-stale-settlement-fence.zh.md)相互独立。

## 考虑过的替代方案

**删去空白或所有末尾 CR/LF。** 这些字符是 POSIX 上合法的文件名内容，无法通过裁剪区分它们和协议终止符。

**将 CRLF 视为两个字符的终止符。** 这些 POSIX 工具输出 LF。此前的 CR 可能是文件名的最后一个字符。

## 后果

选择结果保留准确的目录身份，包括末尾的 CR、LF 和重复换行。可运行的 Loader 组合通过生产提供方和外部命令进程验证真实目录及取消结果。回放替换交互式 GUI 选择；不包含物理桌面对话框验证。
