---
kind: upgrade-guide
description: "Runtime asset requests no longer start or replace an unavailable Runtime."
---
# Runtime assets require an already-ready process

English | [中文](guide.zh.md)

## Change

Browser GET/HEAD requests for `/assets/*`, `/favicon.svg`, and plugin JavaScript, CSS or source maps no longer trigger Runtime startup or generation replacement. An unavailable process or lost activity lease returns503; a manually stopped Runtime retains409. Strict revisioned resources use read-only generation references without writing execution activity, and the receiving Runtime requires an exact `runtime-asset` method/URL assertion. Current login, permissions, node lease and revocation checks remain in force. Unversioned resources and dynamic requests retain their ordinary admission.

## Migration

1. Deploy the Gateway and `@deepseek-ai/dsh-gateway-runtime` from the same release. Keep incompatible survivors and their release files until an administrator confirms a safe stopping point; restart them explicitly rather than retrying assets as an upgrade operation.
2. Open the selected workbench, or use its authenticated Start and open action, before retrying failed asset loads. Custom clients must not use asset requests as startup probes.
3. Confirm that ready-generation revisioned GET/HEAD succeeds without changing `harness.instances.last_activity_at`, and that a manually stopped Runtime returns409 without changing its generation or process state. Ordinary workbench entry retains its existing startup behavior. No configuration or data migration is required.
