# Agent Note: 运行中 Send 遵循显示的 Enter 偏好

Status: implemented

[English](2026-09-22-busy-send-follows-enter-setting.md) | 中文

## 问题

繁忙态偏好为 Enter 选择 Queue 或 Steer，但固定使用 Queue 的指针操作会以不同方式投递同一份草稿。普通 Send 标签掩盖了这种差异。草稿保持挂载时设置也可能改变，因此没有订阅偏好的标签可能与下一次点击不一致。

## 决策

Composer 和 Settings 行订阅同一个账户所有的 `busyEnter` store。Composer 根据该值、所寻址 Session 的运行状态及其 steering（中途引导）能力，同时解析 Enter 和主 Send 操作。运行期间，可用的普通消息草稿显示「排队发送」或「插话发送」；命令草稿和不可用输入保留「发送消息」。禁用控件不显示 tooltip，包括 Turn 结束后可用 Stop 变为禁用 Send 的转换。

包内私有的键盘接口执行已解析的投递方式。`InputActions.submit()` 的其他消费者保留 Queue 语义。Cmd/Ctrl+Enter 保留相反模式和空草稿的整队列手势。空白或 owner-blocked 的普通 Session 保留 Stop；可继续子会话保留独立 Stop，父会话离线和 one-shot 限制仍然生效。Host settings schema、账户修订检查、授权及投递窗口行为仍由各自权威负责。

本决策部分取代[运行中草稿取得主 Send 操作](2026-08-31-running-draft-primary-send.zh.md)中的指针仅使用 Queue 策略。该笔记继续拥有主操作位置和 owner block 规则。[Host 支撑的偏好](2026-08-06-host-backed-web-preferences.zh.md)继续拥有持久化和设置隔离。

## 验证

组件回归覆盖两种投递偏好、实时设置变化、命令、上传、空闲 Session、子会话限制和 tooltip 关闭。无密钥的[实时交互场景](../../../../apps/web/tests/live-interactions.e2e.ts)通过 replay 就绪标记停住真实组合的 Turn：Queue 创建可移除的 Host 排队行，Steer 则生成待处理的 steering 气泡，并恰好持久化一次 next-step Inbox 接纳记录。其运行中草稿快照记录按模式显示的按钮名称。

## 备选方案

**让指针 Send 保持 Queue。** 这会使同一偏好下提交同一草稿的两种可见方式产生冲突行为。

**在共享输入操作上公开投递参数。** 只有 composer 需要这项策略。它既有的私有提交接口可以接收模式，无需改变其他 slot 消费者。

**只在点击时读取偏好。** 投递方式会更新，而已挂载按钮的标签仍然陈旧。共享订阅使两者同时保持最新。

## 影响

选择 Steer 的用户通过 Enter 和指针按钮都得到 Steer；Cmd/Ctrl+Enter 可为单条消息选择 Queue。主按钮明确显示该选择，无需增加控件或改变授权。默认值仍为 Queue。
