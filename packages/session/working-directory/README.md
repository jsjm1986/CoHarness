---
description: "Change one Session's working directory inside its project while existing processes retain theirs. The selected directory survives replay and appears in user context. A missing directory restores the original project when it remains available."
kind: "package-reference"
---

# @deepseek-ai/dsh-working-directory

English | [中文](README.zh.md)

## Summary

Change one Session's working directory while existing processes retain theirs. Changes stay inside the Session's original project directory, survive replay, and appear in user context. A missing directory restores the original project when it remains available.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount alongside `fs`, `sessionProjections`, and `systemPrompt`. `defaultDirectory` selects an absolute fallback for Sessions without an original directory; omission uses the launch directory. See the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-working-directory).

```yaml
- name: '@deepseek-ai/dsh-working-directory'
```

`ctx.workingDirectory.get(session)` reads the committed directory; `ctx.workingDirectory.resolve(agent, path)` canonicalizes a candidate without committing; `ctx.workingDirectory.set(agent, path)` validates and commits; `ctx.workingDirectory.ensure(agent)` revalidates the current directory and restores the project root when it disappeared. Paths resolve relative to the current directory and must land inside the Session's original project (`header.cwd`, or `defaultDirectory` when absent) after symlink resolution.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Session projection owns the effective directory and exposes it in Session observations, so cold readers can use it without activating an Agent; the header continues to identify the original project. Changes serialize per Session, validate through the filesystem provider that owns the Session's execution world — a standing-realm `fs` for SSH-bound Sessions, the host `fs` otherwise — check cancellation and Agent lifetime, commit an event, and queue a user-context notice. If notice queuing fails after commit, the operation returns the committed directory and logs a warning; the next request or resume still receives the required directory context. If the provider cannot answer at all (a transport failure rather than a missing-directory answer), validation keeps the recorded directory, commits nothing, and warns once per Session until a later validation succeeds. Prompt assembly validates the current directory before publishing its required context contribution. Existing processes and sandbox grants keep their independent ownership. The [service implementation](src/index.ts) defines the API.

No runtime invariant companion is published because the service reads its only directory state from the Session projection and checks filesystem validity at use.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session group](../README.md) — durable Session services.
- [Testing](../../../docs/testing.md) — composition and replay verification.

-----

<a id="model-experience"></a>
## Model Experience

### Working directory context

#### What the model sees

The current value is `Current working directory: <JSON-quoted absolute path>.` Each committed change, including automatic recovery, attempts to queue a user-context notice through the ordinary Agent inbox. Cancellation or disposal may discard unadmitted notices; the durable directory remains available to the next request. Directory context stays outside the system prompt and remains enabled when optional runtime context is disabled.

#### Token effect

The initial snapshot and changed values add user-context tokens; unchanged snapshots are not repeated.

#### KV Cache effect

Directory transitions append context without replacing the stable system-prompt prefix. A changed directory or recovery creates new context after retained history.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Missing original project** — when the current directory and the original project are both unavailable, prompt assembly rejects every model turn, including chat-only turns. The service does not choose or recreate a repository. Restore the original directory before retrying. Existing shells retain their process-local directories.
- **Missing SSH filesystem** — an SSH-bound Session whose realm provides no `fs` cannot validate or change directories; the service fails closed rather than reading the host filesystem.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
