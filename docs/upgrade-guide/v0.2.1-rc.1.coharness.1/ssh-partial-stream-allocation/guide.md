---
kind: upgrade-guide
description: "Failed SSH process startup retains admission through sibling stream allocation and socket closure."
---

# Failed SSH startup waits for all stream attempts

English | [中文](guide.zh.md)

## Change

When one stream fails during ordinary process startup, `done`, successful range observation and provider disposal wait for sibling stream attempts and allocated socket closure. Remote termination acknowledgement alone cannot release an allocation whose local startup cleanup remains active. The original startup error and independent range-observation failures retain their reporting paths.

## Migration

Rebuild the Host SSH subprocess provider with its matching distribution. No helper protocol field, installed helper digest, setting or stored data changes. Cancelled range observations remain bounded; an unfinished observation retains uncertain occupation until later confirmation. See the [provider reference](../../../../packages/ssh/subprocess-ssh/README.md).
