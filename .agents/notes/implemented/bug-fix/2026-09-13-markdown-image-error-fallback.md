# Agent Note: Markdown image failures keep authored content visible

Status: implemented

English | [中文](2026-09-13-markdown-image-error-fallback.zh.md)

## Problem

An allowed remote image can fail after Markdown has produced an `<img>`. The old renderer left a broken image box with no readable authored content, and a later source change could reuse that failed element.

## Decision

`MarkdownText` owns a small stateful image wrapper for allowed remote images. A load error replaces the image with its authored alt text, or the original destination when alt is empty. The image key includes the resolved source, so a changed source receives a fresh load state. Unsupported or local destinations continue to render their existing inert alt fallback.

## Alternatives considered

**Retry a failed image automatically.** Rejected because an unavailable remote server would create repeated requests and no new information for the reader.

**Show a generic error label.** Rejected because it discards the assistant-authored context that identifies the requested image.

## Consequences

Failed remote media remains readable and source changes can recover without remounting the whole Markdown tree. The wrapper adds one React state cell per rendered remote image and does not alter URL allowlisting, streaming freeze rules, or model-visible text.
