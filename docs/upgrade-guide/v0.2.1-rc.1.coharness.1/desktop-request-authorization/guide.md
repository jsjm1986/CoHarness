---
kind: upgrade-guide
description: "Desktop application routes require current browser authentication through startup and reload."
---

# Upgrade desktop request authorization

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-host-open-in-app` requires `connection` alongside `webServer` and `subprocess`. Missing authentication leaves its routes unregistered. Requests suspended during authentication withdrawal or plugin unload receive 503; current browser refusals keep their authentication status. Catalog and icon results and every new launcher handoff require current authorization. Already opened desktop applications remain independent.

## Action

Rebuild and deploy the host package, and include all three services in custom desktop compositions. Do not use a missing Connection provider to expose anonymous desktop routes. The cloud Web bundle still does not mount this capability. No data migration is required.
