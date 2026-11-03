---
kind: upgrade-guide
description: "Speech disposal waits for accepted work even after routing withdrawal."
---

# Wait for speech provider withdrawal

English | [中文](guide.zh.md)

## Change

Speech provider disposers share one completion and registry shutdown waits providers already removed from routing. A subscription cleanup exception still cancels and joins accepted recognition work before it is reported. New requests fail as soon as routing is withdrawn.

## Migration

Rebuild the speech service. Await the registration disposer before releasing resources that accepted recognition still uses. Repeated calls await the same removal. No service signature, stored setting, Session generation or database migration changes are required.
