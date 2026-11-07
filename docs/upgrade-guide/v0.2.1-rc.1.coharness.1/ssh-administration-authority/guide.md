---
kind: upgrade-guide
description: "Queued SSH target administration and project sharing reject withdrawn authority."
---

# Upgrade SSH target administration

English | [中文](guide.zh.md)

## Change

SSH target reads, registration, coordinate changes, enable/disable/removal and administrative sharing retain current active administrator eligibility inside their database transaction. An account that loses administrator eligibility cannot continue through an earlier HTTP check, including when it owns the project. Refused operations return403 and change no targets or shares.

Project self-service SSH catalog and sharing require an active organization and account, plus current administration or ownership of the active project. Target revision checks, credential-reference preservation and clearing retain their meanings.

## Migration

1. Upgrade the complete Gateway build. Database migrations and browser request fields are unchanged by this authority check.
2. After403, refresh the current account role and organization status. Project owners use their project self-service entry; administrative target management requires an administrator.
3. Verify current administrator and owner controls alongside a request queued before permission withdrawal. See the [Gateway SSH rules](../../../../gateway/README.md).
