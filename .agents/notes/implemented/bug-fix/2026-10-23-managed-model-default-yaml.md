# Agent Note: Managed model defaults in YAML patches

Status: implemented

English | [中文](2026-10-23-managed-model-default-yaml.zh.md)

## Problem

The [organization model default](2026-08-25-organization-default-model-route.md) shares the runtime home patch with user entries. Appending a block-list row after `[]`, a flow sequence, or a document-end marker produces invalid YAML and can prevent runtime startup. Removing the only generated row also has to preserve trailing comments and document markers.

## Decision

The Gateway parses the retained patch as a YAML sequence and adds its marked default row through the YAML document model. Custom `!!js` scalars remain tagged strings during projection. Empty documents receive an empty sequence; removal preserves its position when the managed row was the only row. User rows and comments survive updates, and malformed input fails before file replacement.

## Alternatives considered

**Special-case `[]`.** Other flow sequences and explicit document markers still break, while textual checks duplicate YAML syntax.

**Replace the whole patch with a generated list.** That discards user configuration and comments from a shared file.

## Consequences

Projection can normalize YAML formatting. Repeated writes with the same policy remain byte-stable; user-layer model settings retain their higher precedence.

## Verification

Gateway regressions cover empty and flow sequences, comments, document markers, tagged expressions, removal, repeat writes, and invalid-input preservation. An assembled Loader example loads the projected default, consumes live policy changes from overlapping Gateway refreshes, and rejects a revoked route before adapter dispatch.
