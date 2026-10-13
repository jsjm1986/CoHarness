# Agent Note: 操作控件只保留一个可访问名称，动态状态交给 aria-description

Status: implemented

[English](2026-10-12-stable-action-names-carry-state-in-aria-description.md) | 中文

## Problem

桌面访问确认触发器曾把当前状态拼进 `aria-label`，控件的可访问名称随权限状态变化——空闲时是 `Desktop access`，授权后变成 `Desktop access · granted`。自动化与辅助技术按名称寻址控件；精确名称查找（`getByRole('button', { name: 'Desktop access' })`）只在空闲态命中，状态一旦出现就完全找不到。web verification 套件在桌面确认流程找不到触发器时抓到了这个问题。

## Decision

操作控件把名称与状态作为两个独立事实暴露。`aria-label` 只为动作命名一次，在控件能进入的所有状态下保持不变。动态状态文本放进 `aria-description`，它只补充不改名。有视力的用户继续通过 `title` 看到合并的 `名称 · 状态` 呈现，这对组合原本就在那里。

这就是每个曾把标签拼成 `` `${action} · ${status}` `` 的控件应遵守的契约：拆开两半，名称在前，描述在后。新的带状态触发器从一开始就按同一规则写。

## Alternatives considered

**保留拼接标签，让调用方改用正则匹配。** 随状态变化的名称对辅助技术依然是错的——读屏器会把它报成另一个控件——而且正则查找把拼接格式渗进每个调用方。

**删掉状态文本。** 状态是真实信息；为了稳定名称而删除它，是用可访问性换取位器便利。

## Consequences

`getByRole` 名称查询在所有权限状态下都有效，读屏器报出一个稳定的动作加一段变化的描述。今后任何从实时状态推导 `aria-label` 的控件都会重演这个缺陷；当触发器的名称查找在状态间不稳定时，检查拼接标签模式。

## Verification

`apps/web/tests/desktop-confirmation.e2e.ts` 在产生这次查找失败的授权、保存与撤回各状态下，都能按精确可访问名称找到触发器。

## Related

[共享动效标尺与字义图标语法](../feature/2026-10-12-shared-motion-scale-and-literal-glyph-grammar.zh.md) 规定同一批状态指示器的视觉呈现。
