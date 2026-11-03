---
kind: upgrade-guide
description: "Managed Web document storage is selected from inherited launch credential-channel markers before plugins activate."
---

# Upgrade managed Web document startup

English | [中文](guide.zh.md)

## Change

The Web bundle selects its document provider from the inherited `DSH_GATEWAY_CREDENTIAL_FD` or `DSH_GATEWAY_CREDENTIAL_FILE` recorded in the launch snapshot. A managed launch waits for Gateway and execution identity services; it does not activate local document storage while those plugins load. Standalone launches keep their local provider. Values from project or user environment files cannot select managed storage.

## Action

Deploy the updated `@deepseek-ai/dsh-web-app/cordis.patch.yml` and restart managed runtimes. No document data migration, credential rotation or model call is required. Custom Web overlays that choose document storage by reading the current `gatewayRuntime` service must use the inherited credential-channel markers in the launch snapshot or an explicit provider selection instead. Raw Loader hosts without a launch snapshot select from their inherited process environment.
