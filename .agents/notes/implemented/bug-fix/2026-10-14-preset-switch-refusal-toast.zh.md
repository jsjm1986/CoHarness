# Agent Note: 以横幅宣告 preset 切换拒绝

Status: implemented

[English](2026-10-14-preset-switch-refusal-toast.md) | 中文

## Problem

`AgentPresetSeatState.error` 原本只是裸字符串，chip 也仅以触发按钮的 `title` 提示呈现它。一次被拒绝的选择——宿主返回 `agent-preset-locked`、带 `reason` 明细的挂载失败、传输层抛错——因此完全没有任何宣告：暂存的标签悄悄回退到部署默认值，不留原因。更糟的是，拒绝可能在 chip 隐藏之后才到达（「显示代码工作视图」关闭期间产生的 stage 仍会抵达宿主），恰在失败最需要报告时，连 tooltip 通道都不存在。

## Decision

选择失败现在连同其原因一起携带 preset——`error` 变为 `string | { preset: AgentPresetOption; reason: string } | null`——chip 在有对象形态错误挂起时渲染 `Toast` 横幅（`Could not switch to {name}: {reason}`，停留 8 秒，锚定 composer 卡片）。即使 chip 自身不渲染，横幅仍会渲染，因为被拒绝的选择依然需要宣告。`dismissRefusal(refusal)` 在横幅播完后把呈现中的对象降级为裸原因，使触发按钮以 title 保留原因而不重复宣告；它拒绝降级已被取代的对象，因为更新的尝试才拥有横幅。

- `load()` 在名册刷新间保留挂起的拒绝——横幅播放期间到达的 `list` 应答或失败不再将其覆盖；字符串错误仍在每次 load 时重置。
- 被拒的 `preset` 优先在名册选项中解析，查不到时回退为 `{ id, trust: 'system' }`，使条目已离开名册的选择仍能报出名字（`trust: 'system'` 可解析内置的本地化名称，否则落到 id）。
- `syncBlankSession` 把对象解包为 `reason`，保持设置分区的 `Promise<string | undefined>` 契约不变。

## Alternatives considered

**错误保持字符串、由字符串渲染横幅。** 横幅文案要点名 preset——而拒绝发生时暂存的 id 已被清空，仅凭字符串无法还原是哪个选择失败了。

**把横幅挂到 chip 之外**（像 `RowActionToast` 那样挂 `shell.overlay` 宿主）。chip 自身的挂载点就是持有拒绝状态的表层，且 chip 在整个 conversation 作用域内保持注册；额外的 overlay 条目拥有的只是同一份快照。

## Consequences

每一次被拒绝的选择都会带着它所点名的 preset 与宿主给出的原因得到宣告，包括选择器已隐藏后才到达的拒绝。`dismissRefusal` 以对象同一性为键完成消除，因此对同一 preset 的第二次拒绝会重播横幅，而不是继承上一次的沉默。

## Verification

`apply.client.spec.ts`——返回式与抛错式选择失败均产生 `{ preset, reason }` 对象；`dismissRefusal` 降级为裸原因、忽略已被取代的对象；名册刷新保留挂起的拒绝。`components.client.spec.tsx`——横幅点名 preset 与原因、在 chip 隐藏时仍渲染、第二次拒绝时重播、播完后回调 `dismissRefusal`。`ui-agent-preset` 219 个测试通过。

## Related

- [Per-session agent presets](../architecture/2026-08-03-per-session-agent-presets.zh.md)——本宣告所依附的 stage/apply 契约。
- [Preset stage outlives the tools toggle](2026-10-14-preset-stage-outlives-tools-toggle.zh.md)——让 stage 能在选择器隐藏时落地的修复，拒绝因而可能在无 chip 可见时到达。
