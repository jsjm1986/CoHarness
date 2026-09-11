# Upstream sync and upgrade records

English | [中文](README.zh.md)

One home for every upstream-alignment artifact, organized by what the file is.
Each upgrade produces a set of files across these folders, named
`<TYPE>-dsh-<version-or-tag>` so a full set for one release stays findable by
prefix and version.

| Folder | Contents |
| --- | --- |
| `plans/` | `UPGRADE-PLAN-dsh-*.md` — human-readable upgrade plan, per-item status, and the decision trail for one sync. |
| `manifests/` | `UPGRADE-MANIFEST-dsh-*.json` — machine-readable decision inventory: upstream/base/implementation commits, per-item status, verification results, backup hashes, production health ids. |
| `alignment/` | `UPSTREAM-ALIGNMENT-MATRIX-dsh-*.json`, `UPSTREAM-ALIGNMENT-PERFORMANCE-dsh-*.json`, `UPSTREAM-AUDIT-dsh-*.md` — per-item alignment evidence, performance comparison, and audit reports. |

Rules:

- Add new records under the matching folder with the existing `<TYPE>-dsh-<version>` naming; do not invent a new top-level prefix.
- Links between folders use repository-relative paths (`upgrades/plans/…`) so they survive moves; cross-references inside a plan may use `../alignment/…`.
- A record that documents a shipped sync stays as the source of truth for that version; update the facts (paths, names, versions) when the code moves, never rewrite the decision.
