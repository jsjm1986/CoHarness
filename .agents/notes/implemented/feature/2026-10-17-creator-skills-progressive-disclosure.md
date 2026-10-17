# Agent Note: Creator skills use progressive disclosure under the pruner threshold

Status: implemented

English | [中文](2026-10-17-creator-skills-progressive-disclosure.zh.md)

## Problem

The `cordis` preset's `skills/` directory is mounted into every creator-mode session through `dsh-skill-filesystem`. Each `SKILL.md` body is rendered verbatim as a `skill` tool result, and the standard preset's tool-result pruner trims results above `thresholdChars: 8192` code points. A monolithic authoring skill would either lose its tail to pruning or push less-used detail into every session that loads it.

## Decision

The shipped creator skills split into a short procedure and on-demand references. `cordis-plugin-development/SKILL.md` carries only the authoring loop and a routing table; `references/` holds host-plugin, UI-plugin, MCP-bundle, and verification detail, and `templates/` holds copyable bundle skeletons. `editing-cordis-compositions` moves its native-product-subagent walkthrough into `references/native-subagents.md`. `cordis-composition-reference/references/packages.md` is generated from the workspace by `scripts/gen-plugin-packages.ts` and freshness-gated by `verify-plugin-packages` in `doc-sync`.

`apps/cli/tests/creator-skills.spec.ts` renders every shipped `SKILL.md` and asserts the result stays below the pruner threshold, every referenced `references/` or `templates/` path exists, each template's `package.json` and Cordis patch parse through `entryListSchema`, and template JavaScript passes `node --check`. The spec also rejects skill prose that forbids reading DSH package sources — inspection, README, then `lib/` is the documented order — and prose that routes skill files through shell commands, since Desktop ships the directory inside `app.asar`, which only the Host process can open.

The inspection path itself is part of the feature: `cordis_inspect_query` `Config.listConfigs` reports each entry's `packageDir` resolved through `Context.pluginPackages`, and `dsh-shell-env` publishes `DSH_PROFILE` and `DSH_PROFILE_DIR` to every model shell call when the launcher provided a profile context.

## Alternatives considered

**One complete authoring document.** It already exceeded the pruner threshold, so the pruner would cut the tail regardless; a table of contents with on-demand reads keeps the loaded body intact.

**Per-plugin generated docs.** `Config.listConfigs` already exposes the installed package directory; duplicating package READMEs into generated skill files would add a second home for the same facts.

## Consequences

Adding a reference file or template to a shipped skill requires no code change, but the spec binds every referenced path to a real file. Skill edits that push a body over the threshold fail the spec rather than silently truncating in production. Snapshot scenarios that embed a skill body (`skill-load`, `skill-tool-row`) must be refreshed when shipped skill text changes.
