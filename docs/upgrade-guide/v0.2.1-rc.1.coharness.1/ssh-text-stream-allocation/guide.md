---
kind: upgrade-guide
description: "SSH text-stream reservations begin with consumption and report stream errors during iteration."
---

# Consume SSH text streams before allocating remote capacity

English | [中文](guide.zh.md)

## Change

`SshFileSystem.streamText()` returns an iterable that reserves its remote iterator on the first pull. Closing, throwing into or cancelling an unread iterable consumes no helper stream capacity. Previously a discarded unread iterable could leave a remote reservation behind and eventually refuse other reads.

Stream admission and file errors occur during iteration. The helper protocol, capacity limit, version checks and text contents remain compatible.

## Migration

1. Rebuild the SSH filesystem provider. The helper needs no protocol upgrade for this change.
2. Catch failures around the `for await` loop or iterator pull, including the first pull. Awaiting `streamText()` alone does not reserve or validate the remote read.
3. Continue to close started iterators when stopping early; `for await` performs this cleanup on break.
