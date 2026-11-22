# Agent Note: Managed tool authority at the point of use

Status: implemented

English | [中文](2026-11-22-managed-tool-operation-authority.zh.md)

## Problem

Office tools and patch operations pass structured input to their filesystem providers. Their exact file targets are available after resolution. Guarding a tool by its argument names alone misses inputs to those operations. An opt-in Session store without an SSH target field also cannot preserve the execution host on reopen.

## Decision

Office reads and patch planning request authorization for the canonical process path selected by the filesystem provider. The directory guard enforces read or write grants at that point. The observation policy supplies the version of an already observed file before a deletion. SQLite Session storage refuses an SSH-bound header before accepting it.

The managed profile protects the installed sandbox, permission, approval, document, and steward components. Bundle patch paths resolve inside their declaring package. Steward forwards the tool’s cancellation signal and retains approval references for its own calls until their result or Session disposal.

## Alternatives considered

Parsing patch syntax again inside the directory guard would duplicate target resolution and make authorization depend on matching two parsers. Removing invalid managed metadata on write would allow a resumed Session to use a different filesystem. The resolved-path check and explicit storage refusal preserve those decisions at their owners.

## Consequences

File authorization precedes content inspection. A refused patch leaves every file unchanged. Reviewers can observe these decisions in the Office, patch, and directory guard fixtures. Installations using the opt-in SQLite store follow the [SSH-bound Session guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/sqlite-managed-ssh/guide.md).
