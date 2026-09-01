# Agent Note: Selective upstream alpha.2 and alpha.3 integration

Status: implemented

English | [中文](2026-09-01-selective-upstream-alpha2-alpha3-sync.zh.md)

## Problem

The upstream `dsh-v0.1.2-alpha.2` and `dsh-v0.1.2-alpha.3` tags contain product fixes, performance work, package-boundary refactors, and two breaking removals. CoHarness has no common Git ancestor with those tags and carries its own Gateway authorization, ApiProxy transport, Session persistence, UI façade, and mobile presentation. A file-level merge would either discard those local contracts or copy an upstream API that has no corresponding owner here.

## Decision

The fork records both tags and ports behavior at the owning capability rather than merging histories. The complete comparison and status matrix lives in [`UPGRADE-PLAN-dsh-v0.1.2-alpha.2-alpha.3.md`](../../../../UPGRADE-PLAN-dsh-v0.1.2-alpha.2-alpha.3.md); the machine-readable source and decision inventory is [`UPGRADE-MANIFEST-dsh-v0.1.2-alpha.2-alpha.3.json`](../../../../UPGRADE-MANIFEST-dsh-v0.1.2-alpha.2-alpha.3.json).

The shipped code adopts these upstream behaviors:

- Connection generations expose recovery feedback and an immediate retry action through the existing `connected/reconnecting` local state. WebSocket downlinks tolerate two missed heartbeats and one event-loop turn before termination. The upstream browser `online/offline` pause hook is not copied because CoHarness's Connection owns both logical streams and treats transport generation results as its network authority.
- Vendored Loader resolution identifies Node's v1/v2 internal API by method presence. Atomic file replacement retries transient Windows rename interference, and JSONL session probing performs the parent stat only on Windows.
- Schedule contributes a header-aware Session projection and an opt-in read-only browser catalog. Projection cells handle seed boundaries, detached appends, and raw-view identity deduplication; creation checkpoints capture seeded values.
- Agent-preset composition is available to the plugin inventory without activating an unmounted preset. Live rows carry evaluated Fiber state, unresolved `!!js` rows remain conditional, built-in display text is localized, and the settings inventory separates preset and global scope.
- The existing `ui-conversation` façade supplies full-session turn navigation, unloaded-marker loading, fixed-pitch scrolling, viewport-gated `CodeBlock`/`ReadBlock` highlighting, incremental streaming line groups, and Tab completion for highlighted slash commands. Enter and Tab consume a stale pending refinement without choosing an old candidate or falling through to submission. Queue rows omit image markers from text previews, load durable thumbnails through the session-authorized conversation image cache, and retain local queued echoes until their Host `rpcId` appears.
- The Agent loop records waking message identities until claim or discard. A follow-up or steer that arrives in the normal turn-closing microtask therefore reopens a fresh driver, while cancellation, pre-step rejection, and driver failure continue to park retained inbox work.
- `read_image` detects extensionless PNG/JPEG/GIF/WebP attachments from bytes while the AttachmentStore remains authoritative for decode and deployment limits. Continuable subagent follow-ups admit upload-shaped images before inbox acceptance and check the resolved child model's image modality; after that capability lookup, a second disposal check prevents a closing live child from accepting the request.
- Web Search failures retain the effective endpoint and actionable settings location. Built-in permission labels use the active locale while deployment-defined labels remain literal.

The code deliberately retains these CoHarness decisions:

- The Gateway's `TypertGatewayError`/business RPC error taxonomy, project ACL, principal, credential, and participant rules remain authoritative. Upstream's domain-prefixed `RemoteError` and complete `remote.*` controller closure are not substituted.
- `packages/host/apiproxy`, `packages/client/connection`, and `packages/client/runtime` remain the production transport and history-wire owners. Upstream focused `ui-chat`, `session-turn-outline`, and shared utility packages are represented by local equivalents where behavior is already present.
- Session SQLite persistence, its schema/migration/export paths, `SESSION_FORMAT_VERSION = 0`, and `SessionEvent.ignorable` remain available. The alpha.3 SQLite removal is not applied to a fork whose existing users and data depend on that backend.
- The CoHarness DSH release family carries the unique publication version `0.1.2-alpha.3.coharness.1` for the `dsh-v0.1.2-alpha.3` code baseline across the workspace root, publishable `packages/*/*` and `apps/cli`/`apps/web`, and private experimental packages. Its release tag is `dsh-v0.1.2-alpha.3.coharness.1`. `apps/android-shell` remains its independent private application version `0.1.0`; vendored and native release families retain their own version lines. The model-governance plugin's peer pins follow `0.1.2-alpha.3.coharness.1`. This version records the synchronized CoHarness code baseline and does not promise binary compatibility with the upstream release.

Every adopted model-visible or durable behavior has a source event, projection, or wire field and a focused test. Optional Schedule UI remains disabled in the default Web bundle and is enabled only by `examples/web-schedule`.

## Release comparison

The alpha.2 tag spans 1,609 files (`28,539` insertions, `14,727` deletions) and the alpha.3 tag spans 1,043 files (`11,337` insertions, `11,350` deletions), measured with `git diff --no-renames --shortstat`. The release notes list 16 alpha.2 items and 9 alpha.3 items; the comparison also covers non-release-note commits that alter projection semantics, dependency ownership, queue complexity, image admission, and test infrastructure.

The detailed matrix assigns each release-note item to `implemented`, `adapted`, `baseline-equivalent`, or `intentionally not adopted`, and names the local source and test owner. In particular, the matrix distinguishes the alpha.3 turn rail from the pre-existing CoHarness history index, and distinguishes image echo support already present in the baseline from the newly added continuable-subagent admission path.

The focused runtime decisions for Goal projection, `@` directory drill, lazy tool bodies, and inbox linearization are recorded in the [selective runtime adaptation note](2026-09-01-alpha23-selective-runtime-adaptation.md); this audit note remains the release-wide source matrix and version record.

## Verification

The affected package TypeScript programs, focused Vitest suites, Cordis configuration/API catalogs, client package declarations, runtime closure, optional-import and client-domain checks, Schedule and inventory bundles, and translation/documentation pairing checks run against the source plane. An isolated install of the DSH, vendored, and Landlock tarballs with lifecycle scripts disabled reports `0.1.2-alpha.3.coharness.1` from the plain-Node `dsh --version` entry. The Python release converter maps the repository version to the public PEP 440 wheel version `0.1.2a3.post1`; its 13-version-test suite and SDK wheel build pass. The normal macOS lifecycle path remains unverified because `koffi` has no usable prebuilt binary in this environment and CMake is unavailable. The root plan records the exact commands and their local results. Windows native Loader/PTY behavior, real DeepSeek API calls, assembled browser snapshots, and production Gateway timing remain external evidence rather than inferred from macOS tests.

## Alternatives considered

**Reuse the exact upstream npm version.** Rejected because 225 of the 248 DSH package/version pairs already exist in the public registries with upstream repository metadata and different tarball integrity. npm treats a published name/version pair as immutable, so the exact version cannot carry the CoHarness bytes.

**Put the CoHarness suffix in a PEP 440 local version.** Rejected for the public Python wheels because public indexes do not accept local version identifiers. The repository version retains `0.1.2-alpha.3.coharness.1`, while the Python wheel version is the public post-release spelling `0.1.2a3.post1`.

**Merge or cherry-pick the upstream tags.** Rejected because the histories have no common ancestor and the same paths represent different owners. A textual conflict resolution cannot preserve Gateway authorization, history-wire fields, or the local UI composition.

**Copy every upstream package and rename the local surfaces later.** Rejected because the focused package split and `remote.*` closure change public dependency and error boundaries before CoHarness has a compatibility consumer. Local equivalents provide the behavior without creating an unowned second transport.

**Apply the alpha.3 SQLite removal.** Rejected because the fork still serves existing SQLite Session files and its migration/export behavior is part of the deployed business path. Removing the provider would be a data and availability regression, not a cleanup.

**Expose upstream `RemoteError` beside the local taxonomy.** Rejected because two exception vocabularies at one Gateway endpoint would make client code choose by provenance rather than the owning failure category. The existing typed Gateway errors and RPC envelopes already preserve the local authorization and diagnostic contract.

**Enable all new UI and Schedule rows by default.** Rejected because Schedule introduces tools, timers, and projection state, while the fork's default composition intentionally has no reminder capability. The overlay keeps the feature explicit and reversible.

## Consequences

The fork follows upstream user-visible fixes and low-risk runtime hardening while keeping its durable data, authorization, and transport contracts stable. Future upstream tags can be audited against one machine-readable matrix and one decision note instead of relying on release prose or an unsafe merge. The cost is a maintained semantic delta: upstream package names, Remote error codes, SQLite availability, and some focused component APIs are not binary-compatible with CoHarness, and external platform lanes still need to verify the adopted behavior before a production release.
