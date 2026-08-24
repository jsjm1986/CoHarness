# Agent Note: Keep the Gateway admin UI visually and linguistically consistent

Status: implemented

English | [中文](2026-08-25-admin-ui-visual-language-consistency.zh.md)

## Problem

The Gateway admin pages shared design tokens but not every page consumed the same primitives. The Documents dashboard rendered a local metric element with a class that had no stylesheet, so its summary collapsed into a thin inline strip. The Models registration view used unlabeled controls, browser-dependent date placeholders, mixed `model`/`模型` wording, and live requests for every keystroke.

## Decision

Admin dashboards use the shared `Metric` component and its `.metric` state classes. Personal model-registration filters use labeled fields in a responsive grid and submit through explicit `应用筛选` and `重置` actions; editing the draft does not request the API until submission. Provider remains a proper product term, while the user-facing noun is consistently `模型`. Data-table headings keep their authored casing instead of applying a global uppercase transform. The admin brand subtitle uses Chinese `管理端` alongside the rest of the console navigation, and the mobile navigation reserves one column for each of its six destinations.

## Alternatives considered

**Add a second stylesheet for the Documents metric.** This would hide the class mismatch while leaving two metric contracts that could diverge again, so the page now consumes the existing shared component.

**Keep live registration filtering on every input event.** This makes the page noisy on slow links and differs from the other admin filters, so the draft/apply split owns one deliberate request per filter change.

**Translate Provider, BYOK, API, and Token into approximate Chinese terms.** These are product or protocol terms used across the runtime, so they remain stable technical names; only the inconsistent lowercase `model` presentation is localized to `模型`.

## Consequences

The Documents and Usage metric cards now share height, typography, warning tone, and responsive behavior. The Models page has a predictable filter layout at desktop, narrow desktop, and mobile widths, with visible labels and a keyboard-accessible segmented control. Registration queries are reduced while users type, at the cost of one explicit apply action. The six-item mobile navigation stays on one row at the supported compact width. The admin UI unit suite covers the shared metric class and the filter submission boundary.
