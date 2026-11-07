---
kind: upgrade-guide
description: "Native Stagehand startup retains resource ownership through profile creation, admission and Worker readiness."
---

# Retry browser startup after resource ownership changes

English | [中文](guide.zh.md)

## Change

Native Stagehand startup refuses a withdrawn or replaced resource provider, or newly required admission, across asynchronous profile creation, process admission and Worker readiness. It returns unused grants to their original provider and retains failed completion for retry. Previously these waits could start or publish a connection after ownership changed.

After cancellation closes a connection, a fresh Worker uses current admission. An existing owned Chromium range retains its original permit until confirmed termination. Failed reconnects retain their cleanup: another connection waits for its success, and provider shutdown joins pending reconnects before releasing ownership. Previously failed reconnect cleanup could be lost. Browser configuration and Session data remain compatible.

Worker construction and uncertainty-report failures retain both causes and the original report for retry. Another Session cannot acquire the attached browser until that cleanup completes. An acknowledged uncertainty report keeps the permit uncertain.

## Migration

1. Rebuild and deploy matching native Stagehand main and Worker artifacts.
2. Retry refused startup as a fresh browser operation after restoring admission. Do not reuse or transfer the old grant.
3. Direct `openBrowserWorker` callers that retain a mutable provider can pass `admission.assertOwnership`. An undefined `admission.budget` permits independent allocation under that check. Direct `launchChromium` callers can pass the optional fifth ownership-check argument. Omission retains the supplied provider. See the [provider reference](../../../../packages/experimental/browser-use-stagehand-native/README.md).
4. Direct Worker callers must retain `ResourceAcquisitionCleanupError.cleanup` and retry it after accounting is restored; do not discard the original reservation while its report remains unacknowledged.
