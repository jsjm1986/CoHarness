---
kind: upgrade-guide
description: "Model discovery refuses redirects to another origin instead of forwarding credentials."
---

# Upgrade model discovery redirects

English | [中文](guide.zh.md)

## Change

Model discovery in pi-ai and Gateway follows redirects only within the configured origin. A different host, scheme or port returns `DISCOVERY_FAILED` before another request; URL credentials are also refused. This protects Anthropic API keys and deployment authentication headers that Fetch previously forwarded across origins. Same-origin path redirects continue to work, with bounded redirect counts and caller cancellation.

The rule applies to stored and draft credentials in organization and project model settings. It does not change the transport behavior of model-generation requests.

## Migration

1. Review the intended final Provider endpoint. Set its `baseURL` directly in `settings.yaml` or Gateway model settings, retaining the deployment path. Confirm the destination before assigning credentials to it.
2. Retry model discovery. Same-origin redirects return the catalog; origin-changing redirects return a discovery error without contacting their destination. Enter model information manually if the deployment cannot expose discovery on the configured origin.

No stored data migration or new configuration field is required. See the [LLM service](../../../../packages/llm/llm/README.md).
