# util/ — low-level shared utilities

English | [中文](README.zh.md)

These zero-dependency packages provide small primitives shared by multiple capability families. Business semantics remain with each consuming capability.

| Package | Role |
|---|---|
| [`brand/`](brand/README.md) | Provides nominally branded types |
| [`paths/`](home-paths/README.md) | Resolves the Harness data root and shared paths |
| [`package-manifest/`](package-manifest/README.md) | Shared declarations for plugin package manifests |
| [`timeout/`](timeout/README.md) | Provides deadline and timeout classification primitives |
| [`retention/`](output-retention/README.md) | Bounds retained text and item collections |
| [`atomic-write/`](atomic-write/README.md) | Replaces files atomically |
| [`native-command/`](native-command/README.md) | Runs host-native commands without a shell |
| [`crypto/`](crypto/README.md) | Generates browser-safe UUIDs and encodes bytes |


## Summary

The `util/` group gives capability packages shared mechanical primitives instead of duplicate implementations. It covers atomic writes, branded ids, deques, lossless JSON values, UUIDs, Harness-home paths, launch environments, outbound proxy policy, native commands, output retention, time-zone canonicalization, and timeout handling. Every root entry here is a library: it registers no product service or event, and the consuming capability retains the business semantics.
