# Agent Note: 保留 UTF-16 路径并容忍编辑器占位字段

Status: implemented

[English](2026-08-29-upstream-editor-and-win32-fixes.md) | 中文

## 问题

Windows 文件夹选择器使用 UTF-16LE，而有效的 BMP code unit 可能包含零低字节。编辑器工具还会收到模型把未使用字段设为 null 的 JSON 占位对象，但必填字段和删除语义必须保持明确。

## 决策

原生文件夹选择器按 UTF-16LE code unit 扫描，直到两个字节都为零，从而保留 BMP 字符和 surrogate pair。字符串替换编辑器在可选 schema 字段中接受 null 作为省略占位，并在命令分派前将其规范化；`str_replace.new_str` 为 null 时拒绝调用，因此删除仍表示为省略该字段。命令必填字段在缺失、为 null 或现有约定要求非空时继续失败。

## 备选方案

**把任意零字节都当作终止符。** 不予采用：U+XX00 是有效的 UTF-16 code unit，会截断真实路径。

**把 null 当作空替换文本。** 不予采用：模型占位字段会静默改变文件内容；删除仍必须通过省略字段明确表达。

**让所有编辑器字段都必填。** 不予采用：模型提供方经常发送包含所有字段、并将未使用字段设为 null 的完整参数对象。

## 影响

包含“开”等字符的 Windows 路径可以正常访问。编辑器 schema 描述了提供方兼容的 null 形式，但没有削弱命令校验；UI 调用展示会省略 null 的插入位置。

## 测试

原生绑定测试覆盖低字节为零的 BMP 路径。编辑器测试覆盖 schema union、各命令的 null 占位、必填 null 的拒绝、展示以及拒绝调用后文件内容保持不变。
