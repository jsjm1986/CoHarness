# Agent Note：统一移动端会话设置

状态：已实现

[English](2026-08-24-unified-mobile-session-settings.md) | 中文

## 问题

移动端 Composer 使用不同控件承载模型、思考等级和当前会话权限。手机模型选择会跳过思考等级面板，权限控件则收缩成没有文字的盾牌和箭头，用户无法从视觉上建立稳定的交互预期。

## 决定

Composer 只拥有共享移动会话设置 Sheet 的临时 section 状态。模型选择继续使用会话唯一的 ModelDirectory，权限选择继续使用当前 permissions projection 与 `/permission` command。功能组件通过现有 slot 合同渲染 trigger、summary 或 Sheet section，不创建第二套 store 或 command 路径。

宽度不小于 360px 时，模型／思考等级和权限使用同一套控件语法并保留可读文字。最窄布局把两者合并成一个两行会话摘要。Sheet 只保留一个标题行、一条 section strip、一个滚动区、一层遮罩和一种选项行选中态。选择模型后 Sheet 保持打开并刷新思考等级 section。权限仍只修改当前会话，Full access 继续要求显式风险确认。

## Alternatives considered

**继续为模型、思考等级和权限使用彼此独立的移动菜单。** 被拒：每个表面会继续自行发明标题、返回、选中态和窄屏回退方式。

**创建移动端专用模型或权限 store。** 被拒：浏览器会逐渐偏离 Host projection，并增加另一位生命周期拥有者。

**在 320px 下用图标隐藏当前值。** 被拒：有状态的控件必须在打开前仍然可理解；最窄摘要改用两行可读文字。

## 结果

`ui-theme` 拥有共享 compact 控件与选项行度量。`ui-conversation` 拥有 Sheet 的临时呈现状态和通用 section 合同。模型与权限包保留现有业务 face，只增加呈现模式。桌面菜单保持不变。

Sheet 挂载期间，会话 seat 提升自身层级，避免回到底部等浮动对话控件绘制到模态表面之上。没有 live session 时，窄屏 hero 不再渲染空的会话摘要。

## 验证

单元测试覆盖摘要和 section 呈现、模型思考等级选择以及权限 command 提交。浏览器测试覆盖 320/375/390px Composer 几何与统一 Sheet。compact 视觉审计检查新的浅色／深色手机页面；发布前仍要求构建、类型、lint 与 GUI/Web 车道通过。
