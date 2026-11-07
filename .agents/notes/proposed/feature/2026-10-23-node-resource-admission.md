# Agent Note: Node-wide model and process admission

Status: proposed

English | [中文](2026-10-23-node-resource-admission.zh.md)

## Problem

Node-wide pressure and fair-queue settings require admission throughout Runtime execution. [Runtime process admission](../../implemented/architecture/2026-10-23-gateway-runtime-admission.md) limits resident processes and cold starts; it does not govern concurrent model requests, subprocesses, terminals, or persistent workers inside those processes. Independent Runtime semaphores also cannot enforce a shared node policy.

A Runtime-local registration sequence does not uniquely identify an operation. During provider replacement, two providers can obtain the same next sequence while an older request is delayed. Identical actor and Session metadata must not let distinct operations share one permit.

## Proposal

Complete the Gateway and Runtime composition around the PostgreSQL node accountant and host-pressure sampler. A concrete [ResourceBudget](../../../../packages/context/resource-budget/README.md) provider will register the managed Runtime generation before readiness. Each operation receives an opaque identity retained across retries; its sequence orders registration and cancellation. A different identity at the same sequence conflicts. Disconnection, elapsed time, and provider replacement do not prove execution stopped.

The Gateway already starts its accountant and sampler and exposes bounded, bearer-authenticated admission messages. Ordinary authentication requires an active organization and a live owner; completion remains available for the current stopping or revoked Runtime. Confirmed process-range termination reclaims the handle's captured generation; a failed accounting commit retains the handle for retry. Registration and Linux memory observations use the committed deployment policy, including when an older coordinator publishes a sample. The standalone wire bundle includes its validators, and release validation requires its payload only when the compiled API imports resource coordination. The Runtime provider is composed, and model dispatch plus ordinary/terminal subprocess allocation acquire permits. Captured origins survive queueing, queued statuses recheck current authority, and final model guards read current policy before dispatch. Direct workers, complete assembled snapshots, and native-platform lifecycle acceptance remain open.

Cold Runtime starts share the same fresh node pressure credits at local allocation and systemd dispatch. Their bounded waits retain the claimed generation and caller cancellation. Durable allocation state distinguishes preparation from a possible process so bootstrap does not deadlock, while unverified survivors retain protection. The optional resident ceiling defaults to zero; it does not replace pressure admission.

Database starts claim only stopped assignments, and stop writes match the captured generation. Each Linux generation and credential fingerprint own a distinct supervisor unit, allowing a generation number restored from backup to start with a fresh credential. Termination atomically replaces its unit with an empty file before reloading and stopping it; systemd [treats an empty unit as masked](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html), refusing activation. Launch writes use exclusive creation, so a delayed launcher cannot overwrite the stop marker. Retaining these small files prevents late commands after a stop from allocating unaccounted processes. Database generation checks alone cannot provide that process guarantee. Legacy unit names are also masked and stopped during termination; they are never reused for new generations.

Model admission will precede actual adapter dispatch, including retries and auxiliary calls. Process admission will precede allocation and cover ordinary subprocesses, terminals, persistent execution workers, and SSH consumers. An awaited allocation API must update every provider and consumer. Accounting remains occupied until the complete owned execution stops; unconfirmed cleanup remains uncertain until the supervisor confirms termination.

The plugin-market parse Worker uses Runtime infrastructure attribution because its cache fill belongs to the service and can outlive a tool caller that stops waiting. It acquires admission before allocation, and retains the captured permit through termination. Cancellation returns without waiting indefinitely for a pending termination promise; uncertain occupation persists until the thread exits or termination resolves. JSONL migration verifiers also acquire infrastructure process permits, own bounded queues per backend, and retain local slots until physical termination is confirmed. Persistence unload drains accepted migration publications before closing their storage owner. Other direct worker owners still need integration.

The Gateway resolves actor and project facts from authenticated Runtime and captured execution context. Capacity permits grant no execution privilege. Historical billing witnesses cannot replace fresh authorization or establish a reduced participant set. Queued execution must retain its original attribution and recheck required permissions before dispatch. Runtime-owned infrastructure and authenticated agentless operations need explicit attribution without borrowing a later browser request.

Managed compositions must refuse execution when their budget provider is withdrawn. Independent compositions may omit it. Provider disposal must stop admission, cancel owners, and await accepted completion while its reporting transport remains usable. Queue metadata, HTTP work, polling, and cleanup waits require validated limits.

SenseVoice worker startup requests infrastructure process admission with a preparation-owned cancellation signal. Cancellation before a grant prevents native allocation; an unused late grant is returned. Publishing readiness detaches that preparation signal so ending a completed recording does not terminate the shared worker. Inference cancellation and provider shutdown still terminate and await the managed process range.

Stagehand connection Workers acquire a process permit using their exact live Session before allocation. Published Workers remain tied to permit cancellation. A failed termination retains uncertain accounting and the error/exit observers needed to contain failures and accept later proof of exit. Owned Chromium allocations use a private local subprocess provider, with the exact Session retained through admission and range confirmation. Acquisition deadlines include queueing and CDP readiness but detach from a published browser. Failed cleanup retains its profile and retryable owner. Every extension model callback uses the exact live Agent’s registered LLM route through the public ClientLLM API. Each current tool operation captures its asynchronous execution context, preventing later actor attribution from inheriting the first connection’s context. Model admission, fresh authorization, credential resolution, and usage middleware remain in the host; no independent credential crosses into the Worker. Exact auxiliary inputs are logged before dispatch and images first become durable references. Browser cancellation aborts host requests and cleanup joins their settlement independently of Worker termination. Structured and required-tool responses use logged instructions with strict validation because the LLM interface does not expose native response-format or tool-choice options.

Inspector startup acquires an infrastructure process permit before Worker construction, without borrowing an interactive caller. The early Cordis disposal notification cancels queued startup because ordinary effect cleanup waits for plugin initialization. Physical thread exit acknowledges completion; failed termination retains uncertainty and failed startup carries its cleanup to the owner. The published Inspector closes on permit withdrawal.

SSH master and forwarding-control commands use an isolated local subprocess consumer with infrastructure attribution; the public remote subprocess provider remains separate. The [SSH ownership decision](../../implemented/architecture/2026-09-11-posix-ssh-runtime.md) records transport retention through admitted consumer cleanup.

The Python executor uses an isolated local subprocess provider for both its infrastructure-attributed interpreter probe and Session-attributed programs. Public remote subprocess selection cannot move host bootstrap assets or host sandbox authority. The trusted loader maps the inherited control channel to the existing fd-3 wire and removes its launch marker, preserving the program's minimal environment. Native owners retain their platform semantics; a process-group fallback cannot confirm escaped descendants, so complete-range acceptance remains distinct from admission coverage.

MCP stdio uses one private local subprocess provider across protocol discovery, serving and reconnects. Public SDK framing and negotiation remain authoritative; a discovery-only transport refuses the legacy initialize handshake so a disposable probe cannot perform serving initialization. A fresh admitted process adopts the SDK's modern or legacy verdict after probe quiescence. Scoped servers capture the nearest exact live Agent once; global servers use Runtime infrastructure attribution. Programmatic owners retain the explicit mount handle because Cordis scope disposal logs child cleanup errors. Cleanup failure retains both process accounting and the server namespace until a successful retry; browser attachment reservations wait for that same cleanup.

Worker termination and coordinator acknowledgement have separate settlement points. Cleanup retains a successful SDK drain while permitting a later termination or completion-report retry; a failed drain still blocks reuse. Browser resource owners retain actual cleanup callbacks separately from single-shot Cordis effect wrappers, so an Agent-scope failure cannot prevent provider cleanup after the external fault recovers. New acquisition remains stopped throughout provider disposal and its retries.

## Alternatives considered

**Limit resident Runtimes only.** One admitted Runtime can still start many model requests or child processes.

**Deduplicate by sequence and actor metadata.** Provider replacement can reuse a sequence for an otherwise identical, distinct operation and receive its predecessor's permit.

**Use only Runtime-local semaphores.** Several Runtimes or Gateway coordinators would each spend the same node capacity.

**Release on timeout or disconnect.** Execution can survive either event; the next caller would spend capacity still in use.

## Acceptance criteria

- Real PostgreSQL and HTTP scenarios prove cross-Runtime fairness, generation rejection, bounded queues, stale-pressure refusal, idempotent retry, and distinct-operation conflicts.
- Real assembled model and process flows wait for permits, cancel before dispatch, and report confirmed or uncertain cleanup through source and built entrypoints.
- Provider replacement, enclosing-owner shutdown, supervisor survivors, and failed process-tree termination preserve accounting until quiescence is established.
- Configuration, documentation, upgrade guidance, and identifier-free diagnostics describe the actual enforcement and limitations.

## Risks

Admission adds database and transport work to execution startup. Pressure samples can become unavailable, and accounting for uncertain cleanup can require an explicit Runtime restart. Older managed Runtimes cannot safely bypass registration during rollout. Nested work needs actual ownership analysis so a retained process does not cause indefinite queueing or unnecessary refusal of independent work.
