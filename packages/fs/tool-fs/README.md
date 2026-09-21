# @deepseek-ai/dsh-tool-fs

English | [中文](README.zh.md)

The **model-facing filesystem tools** — `read`, `read_image`, `write`, `edit` — and their **executor**. This is the consumer layer of the filesystem stack: it owns tool names, JSON schemas, argument validation, prompt sections, **read windowing**, and result formatting. It reads/writes/edits through the `ctx.fs` provider contract ([`@deepseek-ai/dsh-fs`](../fs)) **directly**. The freshness/observation policy is contributed by a separate plugin ([`@deepseek-ai/dsh-fs-observation-policy`](../fs-observation-policy)) through the `fs/*` event gate; the tool is not method-coupled to it. Under a confining provider, the shared sandbox-policy service is required for per-session execution and the tool exposes escalation for filesystem mutations.

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FsPolicy)                             // @deepseek-ai/dsh-fs-observation-policy (policy gate)
await ctx.plugin(LocalAttachmentStore, { dshHome })       // optional — enables durable read_image results
await ctx.plugin(ToolFs)                                  // this package — read/write/edit, plus read_image with attachments
```

`@deepseek-ai/dsh-fs-observation-policy` is **optional**: omit it and the tools run against the bare provider (unconditional write/overwrite/edit, no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit.

`read_image` registers only while a durable `ctx.attachments` service is mounted. Execution additionally requires the exact routed model to declare `image` input, resolved through `ctx.llm.resolveModelInfo` from the session's latest request header and then from agent options.

## Summary

Use `dsh-tool-fs` to let a model read UTF-8 files with line numbers, read supported images, create or atomically replace files, and apply targeted literal edits. Results are capped, and failures provide stable error codes and recovery instructions. Add `dsh-fs-observation-policy` when writes and edits must follow a successful read; without it, mutations remain atomic but are unconditional. Image reads require durable attachment storage and an image-capable routed model. Choose the sibling discovery package for glob or grep searches.

## Config

All keys are optional; the defaults are the shipped read caps.

| Key | Default | Meaning |
|---|---|---|
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call (the tool schema advertises it as the `limit` default). |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation (the suffix names the cap). |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a "capped" footer. |
| `readStreamMinSize` | `10485760` | Files at or above this size (or with unknown size) stream instead of loading whole into memory. |

## Tools (schemas per [the filesystem tool schemas Agent Note](../../../.agents/notes/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at the configured `readLimit` (2000). |
| `read_image` | `file_path` | Reads a PNG/JPEG/WebP/GIF file through the bounded byte seam, persists it through `ctx.attachments.saveImage`, and returns an image block beside a small metadata envelope. Harness validates and downscales large supported images before the next model request, so the model can read the source directly without first creating a thumbnail. It succeeds only when the exact routed model declares image input. |
| `write` | `file_path`, `content` | Create or fully replace a file. With the policy plugin: overwriting an existing file requires a prior `read` at the unchanged version; creating a new file does not. Without it: unconditional. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. With the policy plugin: requires a prior `read` (any window) and the file unchanged since. Without it: unconditional. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

Structured successes are `read` → `{ path, offset, lines: [{ number, text }], totalLines }`, `read_image` → `{ path, image: { attachmentId, mediaType, bytes, width, height, name?, originalDimensions?: { width, height } } }`, `write` → `{ path, operation: 'create' | 'update', before: string | null, after }`, and `edit` → `{ path, before, after }`. `originalDimensions` appears only when normalization downscaled the submitted raster and records its orientation-applied input size. Native renderers preserve the line-numbered read and mutation acknowledgements below. `write`/`edit` derive replayable diff-card metadata, and `read` derives a replayable read-card window `{ path, offset, lines, totalLines, lang? }`; execution-local structured values are not added to `tool/result`, while image renderers emit the durable image blocks that the result logs.

## The tool is the executor; policy is an event gate

The tools do **not** inject a policy service or inspect any cache. Each tool resolves the path via `ctx.fs.resolve(path, { cwd, signal })` — passing the calling agent's session cwd (`exec.agent.session.header.cwd`) so a relative path resolves against the session's workspace, matching `dsh-tool-bash`, and forwarding tool cancellation through resolution (see [the per-session cwd Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-fs-per-session-cwd.md)) — then:

- **read** — one `ctx.fs.stat` (type + size routing + version), then `readText`/`streamText`, then builds the line window, then emits `fs/observed` with a plain `ctx.emit`. (1 stat.)
- **read_image** — validates the argument, extension, attachment availability, deployment media types, and the image-capable route before any I/O; then one `ctx.fs.stat` (recording an `absent` observation for a missing target, like `read`), a bounded `ctx.fs.readBytes` capped at the smaller of `imageLimits.maxImageBytes` and `imageLimits.maxMessageImageBytes` (the result is one message carrying one image), `attachments.saveImage` (content-addressed, so the image block references a durably committed object by the time `tool/result` is appended), and finally `fs/observed`. (1 stat.)
- **write** — `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.writeText(target, content, intent)`, then `fs/observed`. (0 stat.)
- **edit** — `ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.editText(target, edit, intent)`, then `fs/observed`. (0 stat.)

The tool passes `exec` (the tool-execution context) as the opaque `actor` on every dispatch. The default thunks return `undefined` (the unconstrained bare provider). When `@deepseek-ai/dsh-fs-observation-policy` is loaded it occupies the single decision slot — returning `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED` — and records on `fs/observed`. Backend errors (`FsError`) and a thrown `FS_NOT_OBSERVED` flow through `ToolRuntime.execute()` and become `isError` tool results with their `{ name, code }` attached.

When `ctx.fs.sandboxMode` reports confinement, write/edit advertise `sandbox_permissions` and `justification` and resolve approved retries through `ctx.approval`. The policy owner contributes capability-neutral standing policy; the tool results retain operation-specific denial and retry guidance.

## `fs/observed` is fire-and-forget

`fs/observed` fires AFTER the read/read_image/write/edit already succeeded, via a plain `ctx.emit`. A listener is contractually a synchronous, side-effect-only recorder (`@deepseek-ai/dsh-fs-observation-policy`'s is a `WeakMap.set`); the tool does not guard the emit, so a listener that throws would surface as the tool's `isError` result — async or fallible observation does not belong on this event.

`read` opts into concurrent scheduling because its only mutation is the synchronous version recorder. Recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock; both mutation tools remain exclusive. See the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

The package root exports only the Cordis plugin contract (`name`, `inject`, `Config`, and `apply`). Read rendering (line windowing + output formatting) lives in `src/read-render.ts` (Cordis-free, independently unit-tested); `src/read.ts`/`read-image.ts`/`write.ts`/`edit.ts` are the tool executors and `src/index.ts` composes them.

## Model Experience

### System prompt

#### What the model sees

At assembly time, each guidance section checks `ctx.tools.get(name, scope)` and renders only while its tool is visible to that agent. The write paragraph recommends edit only while edit is visible. The text below is unchanged when all three tools are available; restrictions, their removal, and tool registration changes take effect on the next assembly. The same check works for direct agent restrictions and subagent `toolFilter`, including PTC capabilities behind `run_code`. The read-before-mutation sentences in write/edit describe the observation policy, not a requirement to invoke the tool named `read`. They remain when `read` is hidden: the policy still guards mutations, and another observing operation, such as `str_replace_editor` with `command: view`, can establish the same file observation. Tool visibility does not disable that precondition.

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write guidance

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.
```

##### Edit guidance

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Guidance cost follows the visible tools and their applicable cross-tool recommendations.

#### KV Cache effect

Prefix-stable while the visible tool set, plugin scope, and guidance text are unchanged. Restrictions or plugin lifecycle changes may invalidate reuse from the first changed section.

### Tool schemas

#### What the model sees

The model sees the generated [`read`, `read_image`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs), with snake_case arguments. The image tool appears only while a durable attachment store is mounted; its schema is route-independent, and the strict gate refuses at execution. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Read result

#### What the model sees

A successful read is exactly `<path><displayPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`. A missing read still returns `FS_NOT_FOUND`, but it records confirmed absence for the calling session; after an externally deleted file is re-read, a retried `write` can safely recreate it through the provider's no-replace guard.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Image read result

#### What the model sees

A successful `read_image` returns `<path><displayPath></path>`, `<type>image</type>`, and a `<content>` envelope naming the media type, normalized dimensions, and byte size, followed by the image itself as a native image block. The result is logged with its durable reference before the next model request.

#### Token effect

The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`/`maxImageDimension`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns the exact five-line envelope `<path><displayPath></path>`, `<type>file</type>`, `<content>`, `Created file` or `Updated file`, then `</content>`. Edit returns exactly `The file <displayPath> has been updated successfully.` or, for `replace_all`, `The file <displayPath> has been updated. All occurrences were successfully replaced.` The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable validation and read messages are `file_path must be a non-empty string`, `limit must be less than or equal to <max>`, `old_string must be a non-empty string`, `old_string and new_string must differ`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, `offset <offset> is out of range for "<path>" (<total> lines)`, `cannot read "<path>": the <ext> extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`, `cannot read "<path>": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`, `cannot read "<path>": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`, `cannot read "<path>" as an image: model "<model>" does not declare image input; switch to an image-capable model to read images`, and the mismatch repair `cannot read "<path>": the <ext> extension declares <type>, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats` (an extension-less mismatch reports `cannot read "<path>": the file signature claims <type>, but the bytes decode as a different image format; the file may be corrupt`). A failed 16-bit conversion reports `cannot read "<path>": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`. Provider and policy templates are quoted in their package READMEs. The model-facing error wrapper normalizes every `FS_NOT_OBSERVED` source to `cannot modify "<path>": file has not been read — read the file, then retry`; `FS_STALE_VERSION` keeps the provider's reason and adds `— re-read the file, then retry`. Both retain the structured error code and original cause. After that reread confirms absence, `edit` reports `FS_NOT_FOUND` instead of repeating a stale remedy, while `write` uses guarded creation.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No model-facing directory listing ships** — `ctx.fs.listDir` serves provider code such as skill discovery, while the sibling [`dsh-tool-fs-search`](../tool-fs-search/) package supplies ripgrep-backed `glob` and `grep` rather than extending the filesystem seam.
- **`read` handles UTF-8 text files only** — images use the separate extension-routed `read_image` tool; PDF, audio, and video remain deferred. A directory target is `FS_NOT_REGULAR_FILE`.
- **Extension-declared media type** — extension-bearing paths select a declared type and the attachment store's magic-byte validation stays authoritative; an extension-less path is first classified from its leading PNG/JPEG/WebP/GIF signature, then fully decoded by the attachment provider. A wrong extension still receives the rename remedy rather than being silently reclassified.
- **No inline image preview on the tool-result card** — UI surfaces render the image result generically (the durable reference, not pixels); inline rendering is deferred to the UI packages.
- **No attachment-region tool** — an agent may crop an image through other available tools when it has a filesystem path. A pasted or dragged image without a path cannot be re-read at a higher resolution.
- **No timeout surface** — `read`/`write`/`edit` take no timeout argument and declare no `timeout-policy` budget; cancellation rides `exec.signal` only ([provider rationale](../README.md#no-timeouts-on-file-io)).
