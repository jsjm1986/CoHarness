# Agent Note: Parent model control across SSH Codex execution

Status: implemented

English | [中文](2026-10-25-managed-codex-ssh-model-requests.zh.md)

## Problem

A remote Codex process cannot use a model listener bound to the Harness host’s loopback interface. Copying upstream credentials to that process would bypass the [external model request policy](2026-10-25-external-runtime-model-control.md). Forwarding also introduces a cleanup dependency: an SSH connection must remain usable while its consumer drains model requests and removes the remote listener.

## Decision

The [SSH connection](../../../../packages/ssh/ssh/src/index.ts) owns a dynamically allocated reverse TCP forward from the remote loopback interface to the initiating Agent’s local model listener. Codex receives its temporary bridge token and remote port; the parent retains upstream credentials, per-request authorization, resource admission, input persistence and usage attribution. Both one-shot runs and persistent members resolve that connection from their actual standing realm. Remote executable resolution precedes model listener allocation, and persistent recovery starts no listener or process.

Each forward retains its local consumer disposer on the connection before allocation. An allocation already submitted to OpenSSH settles under the administrative deadline even when its caller cancels, so rollback knows the remote port. Removal uses the original zero-port forwarding specification. Cleanup drains the model listener and its requests, cancels the forward and awaits a later helper round trip before reporting success. The round trip confirms processing of the cancellation on the same SSH transport. Complete bounded control output is required; a zero exit status with an OpenSSH error on stderr is failure. An ambiguous allocation or failed cleanup invalidates and joins the local transport, retaining cleanup failures for shutdown reporting.

[Preset mounts](../../../../packages/preset/agent-preset-registry/src/mount.ts) record the fiber that owns their standing environment. File compositions use a child Loader fiber; declared compositions use the standing scope itself. Environment addressing uses the recorded fiber rather than inferring its parent. A missing realm service never falls back to the Host.

## Alternatives considered

**Copy parent API keys or authorize one remote turn.** Neither establishes per-request policy, quota or Session attribution for native inference.

**Add another model RPC protocol.** Reverse forwarding preserves the existing Responses transport and helper protocol, including model input durability and native SSE handling.

**Abort the forwarding control process immediately on caller cancellation.** The master may already have created the listener without reporting its port. Settling allocation before rollback prevents a successful caller cancellation from leaving an unowned remote listener.

**Infer an environment owner from one Loader parent.** Declared and file presets have different Loader ownership. Recording the actual owner keeps both kinds addressable.

## Consequences

Deployments must permit remote TCP forwarding and honor the requested loopback binding. The preinstalled remote Codex command and the selected parent Responses route remain deployment responsibilities. SSH loss still leaves remote execution outcomes unknown; the connection neither reconnects nor replays work. Claude Code and opaque ACP inference retain their unsupported managed-execution behavior.

## Verification

Controlled cleanup barriers cover connection disposal during consumer cleanup and allocation cancellation, malformed or truncated control output, independent consumer and helper failures, and forwarding ownership reuse. Declared-realm tests observe the actual provided filesystem. A Loader composition runs the pinned native Codex through the real remote subprocess/helper path against an owned Responses fixture, checking separate model permits, actor and Session attribution, queued revocation, quota refusal, secret-free durable input and joined process/listener cleanup. The carrier substitutes only the external SSH transport; isolated native OpenSSH verification separately checks the forwarding implementation.
