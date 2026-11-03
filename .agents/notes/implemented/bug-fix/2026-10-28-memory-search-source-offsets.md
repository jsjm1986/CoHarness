# Agent Note: Memory search excerpts retain source positions

Status: implemented

English | [中文](2026-10-28-memory-search-source-offsets.zh.md)

## Problem

NFKC and lowercase matching can expand or combine characters. A normalized match offset cannot index the original content. Long prefixes containing ligatures, compatibility units, decomposed accents or expanding case mappings can produce a matching search result whose excerpt omits the match.

## Decision

Map the normalized UTF-16 hit through NFKD graphemes to the original content's code-point position. The search owns its ICU segmenter. Compatibility decomposition precedes segmentation so compatibility Hangul Jamo compose within the same group. Excerpts use original content, bounded with their ellipses to 160 code points.

[Unicode normalization](https://www.unicode.org/reports/tr15/) defines compatibility decomposition and composition. The [grapheme rules](https://www.unicode.org/reports/tr29/#Normalization) retain canonical composition groups in decomposed text. Source positions are derived from decomposition lengths; character tables remain owned by the runtime.

## Alternatives considered

**Index original text with normalized offsets.** Compatibility expansion, canonical composition and lowercase expansion change those positions.

**Display normalized excerpts.** This changes the source's casing and compatibility characters. Readers need an excerpt of the stored fact.

**Segment original text before compatibility decomposition.** Adjacent compatibility Jamo can occupy separate original graphemes and compose after normalization, retaining the offset error.

## Consequences

Ranking uses normalized text, while excerpts preserve the matched source and its original representation. Mapping traverses the decomposition and source once, using runtime normalization and grapheme segmentation.

## Verification

Source regressions exercise seven prefix families, the inclusive 160-code-point bound and well-formed Unicode. A keyless Loader, Agent, memory tool and real JSON-store snapshot compares the complete excerpt delivered back to the model. The prior compiled implementation omits matches in six of those families.
