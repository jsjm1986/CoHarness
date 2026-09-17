# Agent Note: Unified mobile session settings

Status: implemented

English | [中文](2026-08-24-unified-mobile-session-settings.zh.md)

## Problem

The mobile composer exposed model selection, reasoning effort, and current-session permission through different controls. The model picker skipped the effort pane on phones, while the permission control collapsed to an unlabeled shield and chevron. Users could not form a stable interaction expectation from the visual chrome.

## Decision

The composer owns only the temporary open section for a shared mobile session-settings sheet. Model selection continues to use the session's one ModelDirectory, and permission selection continues to use the current permissions projection and `/permission` command. Feature components render trigger or sheet-section presentations through the slot contract; no feature creates a second store or command path.

Compact widths render the model and permission seats as icon-only triggers on the single toolbar line ([composer single icon row](../bug-fix/2026-09-18-composer-single-icon-row.md)). The sheet keeps one title row, one section strip, one scrollport, one backdrop, and one option-row selection treatment, and remains the surface where full labels live. Selecting a model keeps the sheet open so the reasoning section can refresh. Permission changes remain current-session changes, and Full access keeps its explicit risk confirmation.

## Alternatives considered

**Keep independent mobile menus for model, effort, and permission.** Rejected because each surface would continue to invent its own title, back behavior, selected state, and narrow-screen fallback.

**Create a mobile-only model or permission store.** Rejected because the browser would drift from the Host projection and add another lifecycle owner.

**Hide current values behind icons at 320px.** Rejected because a stateful control must remain understandable before it is opened; the narrow summary used two readable lines instead. Superseded — adopted at every compact width, with the sheet carrying identification ([composer single icon row](../bug-fix/2026-09-18-composer-single-icon-row.md)).

## Consequences

`ui-theme` owns the shared compact control and option-row metrics. `ui-conversation` owns the sheet's temporary presentation state and generic section contract. Model and permission packages keep their existing domain faces and only add presentation modes. Desktop menus remain unchanged.

The conversation seat raises its stacking level while the sheet is mounted, so floating transcript controls cannot paint above the modal surface.

## Verification

Unit tests cover trigger and section presentations, model effort selection, and permission command submission. Browser tests cover 320/375/390 composer geometry and the unified sheet. The compact visual audit checks the resulting light/dark mobile surfaces; build, typecheck, lint, and GUI/Web lanes remain required before publishing.
