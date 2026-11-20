# Agent Note: 触屏用户主动唤起输入区键盘

Status: implemented

[English](2026-11-20-touch-composer-focus.md) | 中文

## Problem

恢复会话时可能在用户交互前聚焦输入区。Android 横屏输入法可能占用几乎整个浏览器视口，使输入框和操作控件在用户尝试点击前就被裁出可见区域。

## Decision

[会话输入区](../../../../packages/client/ui-conversation/README.zh.md)通过主指针媒体查询判断触摸输入，由用户主动聚焦来唤起键盘。已聚焦输入框内的选区仍会滚动到可见位置。桌面的焦点和光标恢复行为保持一致。

Android 验收对可见控件直接使用页面命中检测得到的触点。收起键盘后，预滚动检查可能再次将仍有焦点的输入框滚入视野，使发送按钮在触摸到达之前移位。

极矮的触屏横屏视口通过输入框的 `enterkeyhint` 在支持的输入法上显示「发送」。编辑草稿期间该提示保持稳定，提交仍由支持输入法组词的 Enter 处理器负责。

## Alternatives considered

**用手机宽度阈值判断。** 手机横屏的 CSS 宽度能进入 medium 布局，键盘仍可能占用几乎全部可用高度。

## Consequences

触屏设备冷恢复会话时保留进入输入区的空间。支持该提示的横屏键盘覆盖页面时可以直接发送。收起键盘后可使用页面的发送按钮，草稿会保留。[启动隔离用例](../../../../apps/web/tests/plugin-startup-isolation.e2e.ts)覆盖可选脚本不可用时的会话恢复、多行编辑和发送完成。
