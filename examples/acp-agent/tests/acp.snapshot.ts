import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { copyFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { expect, it } from 'vitest'
import {
  defineAcpSnapshotSuite,
  runScenario,
  type InputScript,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-acp-snapshot'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

/**
 * The acp-agent example's snapshot suite: the scenario table for
 * `dsh-acp-snapshot`'s suite factory, which owns every compare/guard mechanic
 * (expected-output + re-persisted-log diffs, record/refresh write-back, the pinned-header
 * uniformity guard, the fixture guards). Fixtures live under `snapshots/<name>/`;
 * `pnpm run test:snapshot:record` re-records model transcripts against the real
 * API; `pnpm run test:snapshot:refresh` rewrites current replay expected outputs keyless.
 * See the package README (packages/test-support/acp-snapshot) and the snapshot Agent Note,
 * .agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.md.
 */

// The dsh-acp-demo bin (the demo:acp entry), this example's cordis.yml, and
// the repo-root tsconfig (four levels up from examples/acp-agent/tests) — all
// ABSOLUTE: the subprocess cwd is a temp dir outside the repo.
const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}
const EDITING_CORDIS_SKILL = fileURLToPath(new URL(
  '../../../apps/cli/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  import.meta.url,
))

// The PTC overlay configs (include-patched variants of cordis.yml; the
// replay swap resolves each one's sibling `*cordis.snapshot.yml`).
const PTC_CONFIG = fileURLToPath(new URL('../ptc.cordis.yml', import.meta.url))
const PTC_IMAGE_CONFIG = fileURLToPath(new URL('../ptc-image.cordis.yml', import.meta.url))
const PTC_WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../ptc-workspace-context.cordis.yml', import.meta.url))
const BOTH_MODE_CONFIG = fileURLToPath(new URL('../both-mode.cordis.yml', import.meta.url))
const WORKSPACE_CONTEXT_CONFIG = fileURLToPath(new URL('../agent-instructions.cordis.yml', import.meta.url))
const ADVANCED_CONFIG = fileURLToPath(new URL('../advanced.cordis.yml', import.meta.url))
const FS_CONFIG = fileURLToPath(new URL('../fs.cordis.yml', import.meta.url))
const SESSION_QUERY_CONFIG = fileURLToPath(new URL('../session-query.cordis.yml', import.meta.url))
const IMAGE_CONFIG = fileURLToPath(new URL('../image.cordis.yml', import.meta.url))
const IMAGE_OFFLOAD_CONFIG = fileURLToPath(new URL('./fixtures/image-offload.cordis.yml', import.meta.url))
const IMAGE_TEXT_ROUTE_CONFIG = fileURLToPath(new URL('../image-text-route.cordis.yml', import.meta.url))
const PTY_CONFIG = fileURLToPath(new URL('../pty.cordis.yml', import.meta.url))
const DEPTH_TWO_CONFIG = fileURLToPath(new URL('../depth-two.cordis.yml', import.meta.url))
const ACTIVATION_LIMIT_CONFIG = fileURLToPath(new URL('../subagent-activation-limit.cordis.yml', import.meta.url))
const CHILD_QUESTION_CONFIG = fileURLToPath(new URL('../child-question.cordis.yml', import.meta.url))
const SESSION_SANDBOX_ROOT_CONFIG = fileURLToPath(new URL('../session-sandbox-root.cordis.yml', import.meta.url))
const RETRY_CONFIG = fileURLToPath(new URL('../retry.cordis.yml', import.meta.url))
const SESSION_TITLE_CONFIG = fileURLToPath(new URL('../session-title.cordis.yml', import.meta.url))
const SUBAGENT_DURABILITY_FAILURE_CONFIG = fileURLToPath(
  new URL('../subagent-durability-failure.cordis.yml', import.meta.url),
)
const SUBAGENT_CONTINUABLE_INHERITANCE_CONFIG = fileURLToPath(
  new URL('../subagent-continuable-inheritance.cordis.yml', import.meta.url),
)
const SUBAGENT_CURRENT_MODEL_CONFIG = fileURLToPath(
  new URL('../subagent-current-model.cordis.yml', import.meta.url),
)
const LSP_CONFIG = fileURLToPath(new URL('./lsp.cordis.yml', import.meta.url))
const WEB_CONFIG = fileURLToPath(new URL('../web.cordis.yml', import.meta.url))
const FS_SEARCH_CONFIG = fileURLToPath(new URL('./fs-search.cordis.yml', import.meta.url))
const PARTIAL_LANDLOCK_CONFIG = fileURLToPath(new URL('../partial-landlock.cordis.yml', import.meta.url))
const PWSH_CONFIG = fileURLToPath(new URL('./pwsh.cordis.yml', import.meta.url))
const PERSISTENT_PWSH_CONFIG = fileURLToPath(new URL('./persistent-pwsh.cordis.yml', import.meta.url))
const BACKGROUND_TASK_ADMISSION_CONFIG = fileURLToPath(
  new URL('../background-job-admission.cordis.yml', import.meta.url),
)
const PRODUCT_SUBAGENT_CODEX_CONFIG = fileURLToPath(new URL('../product-subagent-codex.cordis.yml', import.meta.url))
const PRODUCT_SUBAGENT_BOTH_CONFIG = fileURLToPath(new URL('../product-subagent-both.cordis.yml', import.meta.url))
const PRODUCT_SUBAGENT_RESULT_DIAGNOSTIC_CONFIG = fileURLToPath(
  new URL('../subagent-result-diagnostic.cordis.yml', import.meta.url),
)
const FS_DIFF_BOUND_CONFIG = fileURLToPath(new URL('./fs-diff-bound.cordis.yml', import.meta.url))
const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots')
const PACKED_CHUNKS_SOURCE = 'hook-cc-pretool-deny'

async function prepareEditingCordisSkillWorkspace(cwd: string): Promise<void> {
  const target = join(cwd, '.dsh', 'skills', 'editing-cordis-compositions', 'SKILL.md')
  await mkdir(dirname(target), { recursive: true })
  await copyFile(EDITING_CORDIS_SKILL, target)
}

async function prepareDelimiterPathWorkspace(cwd: string): Promise<void> {
  const dir = join(cwd, 'scope</system-reminder>')
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(join(dir, 'AGENTS.md'), 'Delimiter path snapshot instruction.\n'),
    writeFile(join(dir, 'task.txt'), 'delimiter path snapshot task\n'),
  ])
}

/**
 * Seed the over-cap glob fixture: eight files under `tree/` with fixed mtimes,
 * so the packaged ripgrep's `--sort=modified` order is deterministic — three
 * files under `archive/`, one each under `docs/`, `src/`, and `test/`, plus
 * two flat files (six top-level entries). Scoping the search to `tree/` keeps
 * the harness's own session artifacts out of the listing.
 */
async function prepareFsSearchWorkspace(cwd: string): Promise<void> {
  const tree = join(cwd, 'tree')
  const files: Array<[relative: string, mtime: Date]> = [
    [join('archive', 'a.ts'), new Date(2000, 0, 1, 0, 0, 0, 1)],
    [join('archive', 'b.ts'), new Date(2000, 0, 1, 0, 0, 0, 2)],
    [join('archive', 'c.ts'), new Date(2000, 0, 1, 0, 0, 0, 3)],
    [join('docs', 'guide.md'), new Date(2000, 0, 1, 0, 0, 0, 4)],
    [join('src', 'index.ts'), new Date(2000, 0, 1, 0, 0, 0, 5)],
    [join('test', 'spec.ts'), new Date(2000, 0, 1, 0, 0, 0, 6)],
    ['top.txt', new Date(2000, 0, 1, 0, 0, 0, 7)],
    ['notes.md', new Date(2000, 0, 1, 0, 0, 0, 8)],
  ]
  for (const [relative, mtime] of files) {
    const target = join(tree, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'fixture\n')
    await utimes(target, mtime, mtime)
  }
}

// TODO(acp-snapshot-ownership): Move backend/product scenarios to headless while
// retaining ACP protocol contracts here.

function fixtureText(name: string): string {
  return readFileSync(join(SNAPSHOTS_DIR, name, 'session.jsonl'), 'utf8')
}

function fixtureRecords(name: string): unknown[] {
  return fixtureText(name)
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as unknown)
}

function snapshotModeFromEnv(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay':
      return 'replay'
    case 'record':
      return 'record'
    case 'refresh':
      return 'refresh'
    default:
      throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const SCENARIOS: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false },
  // text-turn is the default header pin and owns the prompt and tool-schema
  // sidecars reused by alternate classes with identical component sequences.
  { name: 'text-turn', hasModelTurn: true, recorded: true, pinsHeader: true },
  // Product-subagent scenarios are authored schema-isolation fixtures: they
  // reuse the stable text-turn transcript so only Loader-composed headers and
  // tool sidecars vary. Model output and usage are not evidence here, so record
  // mode must not replace them with live-API output.
  {
    name: 'product-subagent-codex',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'product-subagent-codex',
    configPath: PRODUCT_SUBAGENT_CODEX_CONFIG,
  },
  {
    name: 'product-subagent-both',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'product-subagent-both',
    systemPromptSource: 'product-subagent-codex',
    configPath: PRODUCT_SUBAGENT_BOTH_CONFIG,
  },
  {
    name: 'product-subagent-result-diagnostic',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'product-subagent-result-diagnostic',
    systemPromptSource: 'product-subagent-codex',
    configPath: PRODUCT_SUBAGENT_RESULT_DIAGNOSTIC_CONFIG,
  },
  {
    name: 'session-title-after-turn',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: SESSION_TITLE_CONFIG,
  },
  { name: 'tool-call-turn', hasModelTurn: true, recorded: true },
  // Authored from the real PACKED_CHUNKS_SOURCE recording under the ordinary
  // app composition. The contract below pins decoded equality and all three
  // row kinds; replay additionally proves the assembled app re-packs identically.
  { name: 'packed-chunks', hasModelTurn: true, recorded: false },
  // The fs overlay only adds the spill stack (the sandboxed filesystem tools
  // live in the base tree), so these scenarios share the default header class.
  {
    name: 'parallel-tool-calls',
    hasModelTurn: true,
    recorded: false,
    configPath: FS_CONFIG,
  },
  { name: 'bash-spill', hasModelTurn: true, recorded: false, configPath: FS_CONFIG },
  {
    name: 'session-query-spill',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'session-query',
    configPath: SESSION_QUERY_CONFIG,
    posixOnly: true,
  },
  // Authored keyless replays through the assembled app: the replay catalog
  // declares the vision model image-capable and Flash text-only, and the
  // real read_image tool executes against the workspace fixture and the real
  // attachment store. The success route selects the vision model while the
  // refusal route retains text-only Flash, so each pins its exact header.
  {
    name: 'read-image',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'image',
    configPath: IMAGE_CONFIG,
  },
  {
    name: 'read-image-text-route',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'image-text-route',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'read-image',
    configPath: IMAGE_TEXT_ROUTE_CONFIG,
  },
  // Authored keyless replay of the normalization path: the 2001x1 fixture is
  // inside source-admission limits, so the attachment provider normalizes it
  // before the model sees the durable image block. The transcript pins the
  // normalized dimensions and proves that a wide source remains readable.
  {
    name: 'read-image-dimension',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'image',
    configPath: IMAGE_CONFIG,
  },
  {
    name: 'inline-image-prompt',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'image',
    configPath: IMAGE_CONFIG,
  },
  {
    name: 'pty-tools',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'pty',
    configPath: PTY_CONFIG,
  },
  { name: 'bash-tool-turn', hasModelTurn: true, recorded: true },
  {
    name: 'background-job-admission',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: BACKGROUND_TASK_ADMISSION_CONFIG,
    posixOnly: true,
  },
  // The pwsh overlay (pwsh.cordis.yml / pwsh.cordis.snapshot.yml) swaps the
  // bundle's bash tool for the PowerShell twin, so its header class pins its
  // own prompt/tool sidecars and a recorded transcript.
  {
    name: 'pwsh-tool-turn',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'pwsh',
    configPath: PWSH_CONFIG,
    // The composition boots the real pwsh executor; hosts without a `pwsh`
    // binary skip the run (fixtures stay guarded). The recorded turn writes
    // PWSH_OK via [Console]::Out.Write so the fixture carries no platform
    // newline and one recording replays on every host.
    pwshOnly: true,
  },
  {
    name: 'persistent-pwsh-tool-turn',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'persistent-pwsh',
    configPath: PERSISTENT_PWSH_CONFIG,
    pwshOnly: true,
  },
  // Authored keyless replay through a test-only partial-Landlock provider:
  // the exact compatibility notice must stay ordinary stderr when the wrapped
  // `false` command exits 1, rather than becoming SANDBOX_UNAVAILABLE.
  {
    name: 'partial-landlock-child-failure',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'sandbox',
    configPath: PARTIAL_LANDLOCK_CONFIG,
    env: { DSH_PERMISSION_MODE: 'read-only' },
    posixOnly: true,
  },
  // A valid cwd plus a missing provider executable exercises the assembled
  // foreground error and background job marker without a platform runner.
  {
    name: 'missing-sandbox-runner',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'sandbox',
    configPath: PARTIAL_LANDLOCK_CONFIG,
    env: {
      DSH_PERMISSION_MODE: 'read-only',
      DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER: '1',
    },
    posixOnly: true,
  },
  { name: 'todo-write', hasModelTurn: true, recorded: true },
  {
    name: 'skill-load',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'skill',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
    prepareWorkspace: prepareEditingCordisSkillWorkspace,
  },
  { name: 'lsp-definition', hasModelTurn: true, recorded: false, pinsHeader: true, headerClass: 'lsp', configPath: LSP_CONFIG },
  // web_fetch markdown rendering end to end: the overlay's loopback fixture
  // server supplies deterministic HTML (entities, a GFM table, nesting), the
  // REAL local fetch provider retrieves it, and the tool result pins the
  // turndown conversion. The fetched URL (fixed port) is part of the recorded
  // transcript; replay re-executes the real fetch against the same fixture.
  { name: 'web-fetch', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'web', configPath: WEB_CONFIG },
  {
    name: 'workspace-edit',
    hasModelTurn: true,
    recorded: true,
  },
  // The real Loader/app/subprocess path executes the PACKAGED ripgrep binary
  // against a prepared workspace whose fixed mtimes pin the
  // `--sort=modified` order, pinning over-cap glob sampling without depending
  // on a host-installed ripgrep binary or a PATH stand-in. POSIX-only because
  // the displayed paths carry `/` separators the session-log comparison
  // cannot normalize. Recorded (not authored): the assistant turn is a real
  // model transcript; re-record with `test:snapshot:record -t fs-glob-sampling`
  // and then `migrate:packed-session-fixtures`, which canonicalizes the live
  // log's eager-drain-packed rows into the maximal-run layout replay produces.
  // The recorded fixture's `request/header` config and `request/context` are
  // normalized to the minimal fields produced during replay (the live adapter logs
  // model capabilities like maxTokens/reasoningEffort that llm-replay has no
  // data for), and its tool-result paths are canonicalized to `/` separators.
  {
    name: 'fs-glob-sampling',
    hasModelTurn: true,
    recorded: true,
    posixOnly: true,
    pinsHeader: true,
    headerClass: 'fs-search',
    configPath: FS_SEARCH_CONFIG,
    prepareWorkspace: prepareFsSearchWorkspace,
  },
  { name: 'fs-read', hasModelTurn: true, recorded: true },
  { name: 'fs-write', hasModelTurn: true, recorded: true },
  { name: 'fs-edit', hasModelTurn: true, recorded: true },
  { name: 'fs-write-overwrite', hasModelTurn: true, recorded: true },
  // An overwrite whose replacement is at/above the configured diff-basis bound:
  // the persisted result meta carries no contextual hunks and presentation
  // falls back to the whole-file diff. The overlay leaves the prompt and tool
  // sequence identical to text-turn, but the freshly recorded header carries
  // the current adapter capability fields, so the scenario pins its own class.
  {
    name: 'fs-write-overwrite-bounded',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'fs-diff-bound',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
    configPath: FS_DIFF_BOUND_CONFIG,
  },
  { name: 'fs-read-window', hasModelTurn: true, recorded: true },
  { name: 'fs-policy-reject', hasModelTurn: true, recorded: true },
  { name: 'fs-delete-recreate', hasModelTurn: true, recorded: true },
  { name: 'multi-turn', hasModelTurn: true, recorded: true },
  { name: 'error-finish', hasModelTurn: true, recorded: false, overridden: true },
  // Keyless, authored (like error-finish): a live provider cannot be coaxed
  // into a degenerate empty completion, so the fixture scripts the adapters'
  // EMPTY_RESPONSE error finish in turn 1 followed by the recovered reply
  // in retry turn 2, proving the default retry policy end to end: the durable
  // llm/retry event, no ACP output for the discarded attempt, the recovered
  // reply, and a clean completed retry turn. Its overlay only pins a deterministic
  // 1 ms zero-jitter delay, so it shares the default header class.
  { name: 'empty-response-retry', hasModelTurn: true, recorded: false, configPath: RETRY_CONFIG },
  // Keyless, authored (like error-finish): a live model cannot be coaxed into
  // a deterministic mid-tool-call output-limit truncation. Turn 1's script ends
  // at `max-tokens` with an unfinished tool call and adapter replay metadata for
  // both blocks; the durable assistant/message pins assembly dropping the tool
  // call AND pruning its per-block replay entry in the same decision, and turn 2
  // proves the session continues past the truncated step.
  { name: 'max-tokens-continue', hasModelTurn: true, recorded: false },
  // Keyless, authored (like error-finish/cancel): deterministically forcing a
  // LIVE model to repeat one call three times is not a stable recording, so
  // the fixture scripts five identical todo_write calls and pins BOTH reminder
  // tiers (gentle at 3, detailed at 5) as injected user/message in transcript and log.
  { name: 'repeat-tool-reminder', hasModelTurn: true, recorded: false },
  // Authored replay: a root AGENTS.md pins the session prefix, then a read in
  // nested/ discovers its narrower AGENTS.md as a raw, metadata-bearing
  // injected user/message. Both portable AGENTS.md fixtures are symlinks to a sibling
  // AGENTS.canonical.md, so this scenario also guards that discovery follows a
  // symlinked instruction file to its target's content. A second nested path
  // containing a literal closing tag is created at runtime: Git cannot check
  // that name out on Windows, so this delimiter-injection case is POSIX-only.
  // The fixture also shadows the baseline after the first touch finishes its
  // projection; the next entering pre-step restores it before request 2.
  // The scenario-specific config keeps home/root discovery hermetic, and the
  // resulting prefix needs its own pinned header class.
  {
    name: 'agent-instructions',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'agent-instructions',
    toolSchemasSource: 'text-turn',
    configPath: WORKSPACE_CONTEXT_CONFIG,
    prepareWorkspace: prepareDelimiterPathWorkspace,
    posixOnly: true,
  },
  { name: 'cancel', hasModelTurn: true, recorded: false, overridden: true },
  // Cancelling a live bash call relies on POSIX process-group termination;
  // Windows bash process-tree kill is deferred with the Bash execution domain.
  { name: 'cancel-tool-calls', hasModelTurn: true, recorded: false, overridden: true, posixOnly: true },
  { name: 'subagent-spawn-in-process', hasModelTurn: true, recorded: true },
  {
    name: 'subagent-current-model',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'subagent-current-model',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
    pinsChildSystemPrompts: [1],
    configPath: SUBAGENT_CURRENT_MODEL_CONFIG,
  },
  // Keyless authored scenario: the child ends at max-tokens with an empty
  // usage-only assistant/message after earlier text and a tool call. The
  // parent's tool result must retain that assistant output and stop reason.
  { name: 'subagent-max-tokens-partial', hasModelTurn: true, recorded: false },
  { name: 'subagent-multi', hasModelTurn: true, recorded: true },
  // Authored keyless replay: one assistant message carries two subagent calls
  // and the parent log pins call/call/result/result instead of the serial
  // interleaving. The twin delegations must stay identical: replay binds child
  // scripts and harvest order nondeterministically across concurrent children
  // (XXX(concurrent-subagents) in dsh-llm-replay).
  { name: 'subagent-parallel', hasModelTurn: true, recorded: false },
  { name: 'subagent-fork-in-process', hasModelTurn: true, recorded: true },
  { name: 'subagent-mixed', hasModelTurn: true, recorded: true },
  // Authored continuable-subagent transcript: a background delegation returns
  // only the durable subagent id, two send_message calls steer that same child
  // (the first reaches an idle child and opens its second turn; the second
  // reaches the running child and is claimed at its next step boundary; the
  // parent is never woken with their output), send_message to an unknown
  // subagent id fails without delivering, and the child's retained handle is
  // disposed child-first at teardown despite a failed final durability
  // confirmation. That failed confirmation is also what the settlement notice
  // must report: the child claimed the third message and then died on its
  // durability checkpoint without entering the step, so the notice opening the
  // parent's second turn says the child FAILED and the parent must not read the
  // earlier answer as final. The scenario's fixture fences the child's second
  // turn behind the parent's spawn turn so that notice can only arrive at an
  // idle parent.
  {
    name: 'subagent-continuable',
    hasModelTurn: true,
    recorded: false,
    configPath: SUBAGENT_DURABILITY_FAILURE_CONFIG,
  },
  // Authored policy-inheritance transcript: the root session is switched to
  // read-only at creation (the UI Access switch equivalent), and the
  // continuable background child's log carries that override as a
  // `sandbox/mode` `source: 'delegation'` event, so the child's runtime
  // context states the inherited policy instead of the deployment default.
  // The input also waits for the manager-owned settlement turn, keeping that
  // delivery from racing transcript harvest.
  {
    name: 'subagent-continuable-inheritance',
    hasModelTurn: true,
    recorded: false,
    configPath: SUBAGENT_CONTINUABLE_INHERITANCE_CONFIG,
  },
  // The in-process child is published before its first follow-up fails. The
  // foreground tool retains both that run-result failure and an independent
  // published-handle disposal failure.
  {
    name: 'subagent-published-run-failure',
    env: { DSH_SUBAGENT_PUBLISHED_FAILURE: '1' },
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: SUBAGENT_DURABILITY_FAILURE_CONFIG,
  },
  // Authored durable-catalog transcript: the snapshot-only lifecycle marker
  // fences the second parent turn behind the child's Activation end, so
  // `list_agents({ scope: 'descendants' })` deterministically reads the
  // persisted child as complete, then `interrupt_agent` executes its accepted
  // no-op against that settled id. Both tools run through the assembled control
  // service; the marker is not model-visible.
  {
    name: 'subagent-list-agents',
    hasModelTurn: true,
    recorded: false,
  },
  {
    name: 'subagent-depth-two-rejection',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: DEPTH_TWO_CONFIG,
  },
  // Authored keyless replay: one live continuable child fills the configured
  // one-slot pool, so the second continuable start is refused by the tool while
  // the first stays resident.
  {
    name: 'subagent-activation-limit',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    configPath: ACTIVATION_LIMIT_CONFIG,
  },
  // Authored keyless replay through the assembled app: a one-shot child calls
  // the real ask_user_question tool, the runtime-ownership guard rejects before
  // the tripwire provider, and the child carries the unresolved decision in its
  // final result so the parent can complete instead of waiting forever.
  {
    name: 'subagent-child-question-rejection',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'child-question',
    systemPromptSource: 'text-turn',
    configPath: CHILD_QUESTION_CONFIG,
  },
  // The workflow tool: the model writes a one-child orchestration script; the
  // child runs as a spawn subagent under the worker-thread engine (its session is the
  // child fixture), and the tool result carries the script's return value.
  { name: 'workflow-run', hasModelTurn: true, recorded: true },
  // Authored counterpart to the packaged Python SDK snapshot: define a host-half marker package and
  // run it, inspect this session's dynamic packages through PTC, run direct and workflow
  // children, then undefine it. The extra PTC and
  // Cordis plugins require their own request-header pin; the fixture tests deterministic composition.
  {
    name: 'advanced-toolchain',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  {
    name: 'cordis-inspect-jsdoc',
    hasModelTurn: true,
    recorded: false,
    headerClass: 'advanced',
    configPath: ADVANCED_CONFIG,
  },
  // Prompt-submit blocks are authored keylessly with malformed matcher fields,
  // which these matcherless events must ignore. Admission rejects before a turn
  // opens, so only the ACP stop reason is observable and no log is harvested.
  { name: 'hook-cc-promptsubmit-block', hasModelTurn: false, recorded: false },
  { name: 'hook-codex-promptsubmit-block', hasModelTurn: false, recorded: false },
  // Each invalid matcher follows a runnable prompt blocker. Reaching the replay
  // model without any hook audit rows proves config loading is atomic through
  // the real Loader/app path, rather than retaining the earlier valid group.
  { name: 'hook-cc-invalid-matcher', hasModelTurn: true, recorded: false },
  { name: 'hook-codex-invalid-matcher', hasModelTurn: true, recorded: false },
  // The mid-turn interception points fire during a real model turn, so each is recorded with its hook active
  // (the model's reaction to a deny/block/force-continue is part of the captured transcript).
  // SessionStart/SubagentStart are excluded because detached injection races log
  // order; SubagentStop writes no transcript, so an expected output could not prove it ran.
  // Unit tests cover those points; the hook-snapshot-matrix Agent Note owns the rationale.
  { name: 'hook-cc-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-deny', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-pretool-ask', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-cc-stop-continue', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-promptsubmit-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-pretool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-block', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-posttool-context', hasModelTurn: true, recorded: true },
  { name: 'hook-codex-stop-continue', hasModelTurn: true, recorded: true },
  // PTC: the registry in `mode: ptc` — the wire tool list collapses to [run_code], the
  // tools:sdk section rides in the prompt, and the program's tool calls land as
  // tool/ptc-dispatch events. Each overlay composes and pins its own header class.
  { name: 'ptc-turn', hasModelTurn: true, recorded: true, pinsHeader: true, headerClass: 'ptc', configPath: PTC_CONFIG },
  {
    name: 'ptc-read-image',
    hasModelTurn: true,
    recorded: false,
    pinsHeader: true,
    headerClass: 'ptc-image',
    toolSchemasSource: 'ptc-turn',
    configPath: PTC_IMAGE_CONFIG,
    posixOnly: true,
  },
  // A nested fs dispatch inside run_code discovers workspace instructions. The
  // projection enters the inbox after the outer result and becomes model-visible
  // on the following step, retaining workspace source identity end to end.
  {
    name: 'ptc-workspace-context',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    pinsHeader: true,
    headerClass: 'ptc-workspace-context',
    systemPromptSource: 'ptc-turn',
    toolSchemasSource: 'ptc-turn',
    configPath: PTC_WORKSPACE_CONTEXT_CONFIG,
  },
  // `both` owns its own expected prompt rather than sharing ptc-turn's:
  // the two modes agree on every section except the run_code-only rule, which
  // `both` must NOT state because its native calls do execute.
  {
    name: 'both-mode-turn',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'both',
    configPath: BOTH_MODE_CONFIG,
  },
  // Machine permission scenarios use an explicit deployment policy; there is
  // no session-scoped UI picker on the automation protocol.
  {
    name: 'escalation-approved',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'sandbox',
    systemPromptSource: 'text-turn',
    toolSchemasSource: 'text-turn',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'escalation-rejected',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'fs-escalation-approved',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'fs-same-mode',
    hasModelTurn: true,
    recorded: false,
  },
  // Unlike ordinary snapshots, this session cwd is outside the platform temp
  // roots that workspace-write always grants. The overlay points the
  // deployment fallback at /tmp, so a successful relative write proves the
  // assembled app replaced that process-level fallback with SessionHeader.cwd.
  {
    name: 'session-sandbox-root',
    hasModelTurn: true,
    recorded: false,
    overridden: true,
    headerClass: 'sandbox',
    configPath: SESSION_SANDBOX_ROOT_CONFIG,
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
    workspaceParent: homedir(),
  },
]

// Hosts without a usable PowerShell skip the pwsh-tool-turn run (its fixtures
// stay guarded); the probe follows the executor's own resolution so a Windows
// host with only an install-location pwsh still runs the scenario.
const hasPwsh = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: SNAPSHOTS_DIR,
  scenarios: SCENARIOS,
  mode: snapshotModeFromEnv(process.env.DSH_SNAPSHOT),
  hasPwsh,
})

it.each(['chat-completions', 'messages'] as const)('pins %s Files offload and inline fallback in assembled requests', async (protocol) => {
  const filesPath = protocol === 'messages' ? '/v1/files' : '/files'
  const modelPath = protocol === 'messages' ? '/v1/messages' : '/chat/completions'
  const requests: Record<string, unknown>[] = []
  const fileRequests: Array<{ method: string; path: string; bytes: number }> = []
  let rejectFiles = false
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const body = Buffer.concat(chunks)
        // The file representation deliberately exercises the native DeepSeek
        // Files API before the model request. Its multipart body is not JSON
        // and must not be counted as a completion request.
        if (url.pathname === filesPath && request.method === 'POST') {
          const headers = new Headers()
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          }
          const form = await new Request('http://127.0.0.1/files', {
            method: 'POST', headers, body,
          }).formData()
          const file = form.get('file')
          if (!(file instanceof Blob)) throw new Error('snapshot Files upload omitted file')
          fileRequests.push({ method: 'POST', path: url.pathname, bytes: file.size })
          if (rejectFiles) {
            response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({
              error: { message: 'Files temporarily unavailable' },
            }))
            return
          }
          const createdAt = Math.floor(Date.now() / 1_000)
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(protocol === 'messages' ? {
            id: 'file-api-snapshot-1',
            type: 'file',
            size_bytes: file.size,
            created_at: new Date(createdAt * 1_000).toISOString(),
            filename: 'dsh-snapshot.png',
            mime_type: file.type,
          } : {
            id: 'file-api-snapshot-1',
            object: 'file',
            bytes: file.size,
            created_at: createdAt,
            filename: 'dsh-snapshot.png',
            purpose: 'user_data',
            expires_at: createdAt + Number(form.get('expires_after[seconds]')),
          }))
          return
        }
        if (url.pathname !== modelPath) {
          response.writeHead(404).end()
          return
        }
        requests.push(JSON.parse(body.toString('utf8')) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (protocol === 'messages') {
          const toolCall = requests.length === 1
          const events = [
            { type: 'message_start', message: { id: 'offload-response', model: 'deepseek-v4-flash-vision-exp', usage: { input_tokens: 3, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: toolCall
              ? { type: 'tool_use', id: 'native-read-image', name: 'read_image', input: { file_path: 'red.png' } }
              : { type: 'text', text: 'DONE' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ]
          response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
          return
        }
        const events = requests.length === 1
          ? [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"native-read-image","type":"function","function":{"name":"read_image","arguments":"{\\"file_path\\":\\"red.png\\"}"}}]},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ]
          : [
            'data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"content":"DONE"},"index":0,"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ]
        response.end(events.join('\n\n'))
      })().catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('image-offload snapshot server has no port')

  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
  const input: InputScript = {
    steps: [
      { op: 'initialize' },
      { op: 'newSession' },
      {
        op: 'promptContent',
        content: [
          { type: 'text', text: 'Compare the older image ' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: ' with the newer image ' },
          { type: 'image', data: image, mimeType: 'image/png' },
          { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
        ],
      },
    ],
  }

  try {
    const result = await runScenario(input, {
      agent: AGENT,
      mode: 'record',
      configPath: IMAGE_OFFLOAD_CONFIG,
      fixtureFile: join(SNAPSHOTS_DIR, 'image-offload-request', 'session.jsonl'),
      workspaceDir: join(SNAPSHOTS_DIR, 'read-image', 'workspace'),
      env: {
        DSH_SNAPSHOT_PROTOCOL: protocol,
        DSH_SNAPSHOT_API_KEY: 'snapshot-key',
        DSH_SNAPSHOT_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    expect(result.stderr).toBe('')
    expect(requests).toHaveLength(2)
    expect(fileRequests).toEqual([{ method: 'POST', path: filesPath, bytes: 69 }])
    const attachmentDigest = 'b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640'
    const attachmentId = `sha256:${attachmentDigest}`
    const accessText = (cwd: string): string => {
      const attachmentPath = join(
        cwd,
        '.dsh',
        'attachments',
        'v1',
        'objects',
        attachmentDigest.slice(0, 2),
        attachmentDigest,
      )
      return ` Normalized copy (read-only; may be resized or re-encoded): ${JSON.stringify(attachmentPath)} (1x1px, image/png).`
        + ' Source dimensions, format, and byte size may differ.'
        + ' Copy to a writable path ending in .png before editing.'
    }
    const normalizedAccess = accessText(result.cwd)
    const imagePrefix = protocol === 'messages' ? '' : '\n'
    const fileImage = protocol === 'messages'
      ? { type: 'image', source: { type: 'file', file_id: 'file-api-snapshot-1' } }
      : { type: 'file', file_id: 'file-api-snapshot-1' }
    const offloadedImage = `[image omitted to fit request image limits; ${attachmentId}.${normalizedAccess}]`
    const imageHandle = `Image ${attachmentId}; request preview 1x1px.${normalizedAccess}`
    const normalizedToolImageHandle = `Image "red.png" (${attachmentId}); request preview 1x1px.${normalizedAccess}`
      .replaceAll(result.cwd, '{{cwd}}')
    const runtimeContext = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
      + 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.\n\n'
      + 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
    const messages = requests[0]?.messages as { content?: unknown }[] | undefined
    const offloaded = messages?.find(message => JSON.stringify(message.content).includes('[image omitted'))
    expect(offloaded?.content).toEqual([
      { type: 'text', text: 'Compare the older image ' },
      { type: 'text', text: offloadedImage },
      { type: 'text', text: ' with the newer image ' },
      { type: 'text', text: `${imagePrefix}${imageHandle}` },
      fileImage,
      { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
      ...protocol === 'messages' ? [{ type: 'text', text: runtimeContext }] : [],
    ])

    if (protocol === 'messages') {
      const followup = requests[1]?.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
      expect(followup).toHaveLength(3)
      expect(followup[0]?.content.filter(block => block.type === 'image')).toEqual([])
      expect(followup[0]?.content.filter(block => block.text === offloadedImage)).toHaveLength(2)
      expect(followup[1]).toEqual({ role: 'assistant', content: [
        { type: 'tool_use', id: 'native-read-image', name: 'read_image', input: { file_path: 'red.png' } },
      ] })
      expect(followup[2]?.role).toBe('user')
      expect(followup[2]?.content).toHaveLength(1)
      const toolResult = followup[2]!.content[0]!
      expect(toolResult.type).toBe('tool_result')
      expect(toolResult.tool_use_id).toBe('native-read-image')
      const content = toolResult.content as Array<Record<string, unknown>>
      expect(content[0]?.type).toBe('text')
      expect(content[0]?.text).toContain('image/png image, 1x1 px, 69 bytes')
      expect(content.slice(1)).toEqual([
        { type: 'text', text: `Image "red.png" (${attachmentId}); request preview 1x1px.${normalizedAccess}` },
        fileImage,
      ])
    } else {
      const followup = structuredClone((requests[1]?.messages as unknown[]).slice(1)) as Array<{
        role?: unknown
        content?: unknown
      }>
      const toolMessage = followup.find(message => message.role === 'tool')
      if (toolMessage === undefined || typeof toolMessage.content !== 'string') {
        throw new Error('native read_image request has no tool content')
      }
      const cwdSpellings = [...new Set([result.cwd, ...result.cwdAliases].flatMap(cwd => (
        cwd.startsWith('/private/') ? [cwd, cwd.slice('/private'.length)] : [cwd, `/private${cwd}`]
      )))]
      let toolContent = toolMessage.content
      for (const cwd of cwdSpellings) toolContent = toolContent.replaceAll(cwd, '{{cwd}}')
      toolMessage.content = toolContent
      expect(followup).toEqual([
        {
          role: 'user',
          content: `Compare the older image ${offloadedImage} with the newer image ${offloadedImage}, then use read_image on red.png and reply with DONE.`,
        },
        {
          role: 'user',
          content: runtimeContext,
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'native-read-image',
            type: 'function',
            function: { name: 'read_image', arguments: '{"file_path":"red.png"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'native-read-image',
          content: '<path>{{cwd}}/red.png</path>\n<type>image</type>\n<content>\nimage/png image, 1x1 px, 69 bytes\n'
            + `</content>\n${normalizedToolImageHandle}`,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Attached image(s) from tool result:' },
            { type: 'file', file_id: 'file-api-snapshot-1' },
          ],
        },
      ])
    }

    rejectFiles = true
    const fallback = await runScenario(input, {
      agent: AGENT,
      mode: 'record',
      configPath: IMAGE_OFFLOAD_CONFIG,
      fixtureFile: join(SNAPSHOTS_DIR, 'image-offload-request', 'session.jsonl'),
      workspaceDir: join(SNAPSHOTS_DIR, 'read-image', 'workspace'),
      env: {
        DSH_SNAPSHOT_PROTOCOL: protocol,
        DSH_SNAPSHOT_API_KEY: 'snapshot-fallback-key',
        DSH_SNAPSHOT_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    expect(fallback.stderr).toBe('')
    expect(fileRequests).toEqual([
      { method: 'POST', path: filesPath, bytes: 69 },
      { method: 'POST', path: filesPath, bytes: 69 },
    ])
    expect(requests).toHaveLength(3)
    const fallbackMessages = requests[2]?.messages as { content?: unknown }[] | undefined
    const fallbackInput = fallbackMessages?.find(message => JSON.stringify(message.content).includes('[image omitted'))
    const fallbackAccess = accessText(fallback.cwd)
    expect(fallbackInput?.content).toEqual([
      { type: 'text', text: 'Compare the older image ' },
      { type: 'text', text: `[image omitted to fit request image limits; ${attachmentId}.${fallbackAccess}]` },
      { type: 'text', text: ' with the newer image ' },
      { type: 'text', text: `${imagePrefix}Image ${attachmentId}; request preview 1x1px.${fallbackAccess}` },
      protocol === 'messages'
        ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }
        : { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
      { type: 'text', text: ', then use read_image on red.png and reply with DONE.' },
      ...protocol === 'messages' ? [{ type: 'text', text: runtimeContext }] : [],
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
}, 45_000)

it('packed ACP fixture retains every chunk row kind without changing the logical session', () => {
  const source = fixtureText(PACKED_CHUNKS_SOURCE)
  const packedText = fixtureText('packed-chunks')
  const packed = fixtureRecords('packed-chunks')
  const rowTypes = packed.flatMap((record) => {
    if (record === null || typeof record !== 'object') return []
    const body = (record as { data?: unknown }).data
    const stream = body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { stream?: unknown }).stream
      : undefined
    const items = Array.isArray(stream) ? stream : [record]
    return items.flatMap((item) => {
      if (item === null || typeof item !== 'object') return []
      const type = (item as { type?: unknown }).type
      return type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks' ? [type] : []
    })
  })

  expect([...new Set(rowTypes)].sort()).toStrictEqual(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])
  const withoutMessageId = (record: unknown): unknown => {
    const cloned = structuredClone(record) as {
      time?: unknown
      type?: unknown
      data?: {
        durationMs?: unknown
        id?: unknown
        inserted?: Array<{ id?: unknown }>
        message?: { id?: unknown }
        stream?: unknown
      }
    }
    delete cloned.time
    if (cloned.type === 'agent/inbox/spliced') {
      for (const message of cloned.data?.inserted ?? []) delete message.id
    }
    if (cloned.type === 'user/message') delete cloned.data?.id
    if (cloned.type === 'system/message'
      || cloned.type === 'assistant/message'
      || cloned.type === 'tool/result') {
      delete cloned.data?.message?.id
    }
    // The migrated durable events above retain the sequence under test;
    // settlement streams additionally carry the replay run's volatile clocks.
    if (cloned.type === 'assistant/message' || cloned.type === 'assistant/attempt') delete cloned.data?.stream
    if (cloned.type === 'hook/result') delete cloned.data?.durationMs
    return cloned
  }
  const logicalRecords = (fixture: string): unknown[] => [
    // Packed stream items differ in generation fields, so compare header
    // content minus the generation fields.
    ((header: Record<string, unknown>) => {
      delete header.version
      delete header.isSeeded
      return header
    })(JSON.parse(fixture.split(/\r?\n/).find(line => line.trim().length > 0) as string) as Record<string, unknown>),
    ...parseSessionLog(fixture).map(withoutMessageId),
  ]
  expect(logicalRecords(packedText)).toStrictEqual(logicalRecords(source))
})
