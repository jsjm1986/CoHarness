---
kind: upgrade-guide
description: "New Gateway releases require the local supervisor and a verified fingerprint of the Runtime dependency payload."
---

# Upgrade the Gateway Runtime release fingerprint

English | [中文](guide.zh.md)

## Change

Gateway launch stamps use the resolved CLI and Web runtime package files and their dependency links. Production builds record this fingerprint in `gateway/lib/runtime-dependencies.json`. macOS activation checks `gateway/deploy/required-release-files.txt` and verifies the fingerprint before changing the selected release. A Runtime carrying the earlier stamp format remains supervised and awaits a compatible restart before accepting new forwarding.

## Migration

1. Build the candidate with `pnpm run build:production`. Stage the complete release, including `gateway/lib/local-runtime-supervisor.js`, the recorded fingerprint, and its installed package links.
2. Stop retained Runtime generations at a safe point using the owning Gateway's Runtime controls. Keep their release directories until process exit is confirmed. Check the Session shutdown outcome for each stopped generation.
3. Follow [the macOS activation procedure](../../../../gateway/deploy/README.md) for the staged release. After activation, start a managed Runtime and verify it reaches readiness under the new release.
