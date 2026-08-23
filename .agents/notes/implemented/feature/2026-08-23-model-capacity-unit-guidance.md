# Agent Note: Model capacity unit guidance

Status: implemented

English | [中文](2026-08-23-model-capacity-unit-guidance.zh.md)

## Problem

The model settings card stored both `contextWindow` and `maxTokens` as token counts, but the labels did not state the unit or explain the decimal `K`/`M` suffixes. A value such as `1M` appeared beside a provider value such as `393216`, making exact token counts look like a different unit. The two fields also have different meanings: context capacity covers the request, while the output cap limits generation.

## Decision

The model editor labels both fields with `(tokens)` and gives one accessible, visible explanation in each expanded row. The explanation states that plain integers and decimal `K`/`M` suffixes are accepted (`K` = 1,000; `M` = 1,000,000), blank fields inherit provider defaults, and the context and output limits are independent. The existing parser, positive-integer validation, shortest round-trip spelling, and JSON number storage remain unchanged, so provider values that are not decimal multiples such as `393216` stay exact.

The same copy and `aria-describedby` relationship is used by the DeepSeek catalog editor and the pi-ai model-list editor. Error messages and README contracts use the same unit vocabulary and examples.

## Alternatives considered

**Convert every value to binary `Ki` units** — rejected because the existing public parser and stored settings use decimal `K`/`M`, and changing the interpretation would silently alter existing configurations.

**Round provider values to the nearest friendly suffix** — rejected because `393216` and `384K` are different token budgets; the UI must not change a provider's exact limit for presentation.

**Show only raw integers** — rejected because large values such as `1000000` are harder to scan and the card already supports safe, reversible shorthand.

## Verification

Focused component tests cover decimal suffix parsing, exact non-multiple formatting, visible guidance, and the accessible description link for both editor variants. The stylesheet token test covers the new help rule. The package README pair and Agent Note pair are checked by the documentation gates.

## Consequences

Users can enter and interpret model capacities without guessing whether a value is bytes, characters, decimal units, or binary units. The wire and persistence formats remain positive integer token counts, and deployments still own the actual provider-compatible relationship between context capacity and output budget.
