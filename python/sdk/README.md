# DeepSeek Harness Python SDK

English | [中文](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.zh.md)

Python subprocess SDK for driving DeepSeek Harness over JSON-RPC stdio. The
runtime inherits normal DeepSeek Harness environment variables such as
`DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, so callers can use real model
endpoints directly or point those variables at a local proxy.

Install the `deepseek-harness-sdk` distribution from PyPI; the import module remains `deepseek_harness`:

```sh
python -m pip install deepseek-harness-sdk
```

Installing `deepseek-harness-sdk` installs the exact same-version `deepseek-harness-runtime-bin` platform wheel. The normal entry point therefore needs no executable argument:

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(dsh_home="./.harness") as harness:
    result = harness.run("Say hi.")
```

`DeepSeekHarness` keeps its lazily started runtime subprocess for reuse across calls. Use it as a context manager, as above, or call `close()` explicitly when finished.

The SDK launches the bundled `dsh` executable with the `sdk` runtime profile. Set `dsh_home` or a nonempty `DSH_HOME` explicitly; the SDK does not choose a personal home implicitly. Use `profile` and ordered `patches` to configure the shipped application. The selected profile must provide stdio JSON-RPC and its required services.

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    dsh_home="./.harness",
    profile="sdk",
    patches=("./sdk.patch.yml",),
) as harness:
    result = harness.run("Make the requested code change.")
```

`provider` selects a provider route registered by the chosen Cordis composition; `model` is the model id resolved by that adapter. `max_tokens` is an optional positive per-request output-token cap for the root agent and its in-process descendants; omission leaves the provider default in control. Compaction summaries keep the separate limit configured by their compaction plugin. The bundled default composition registers `deepseek-official`. A custom composition can mount `llm-pi-ai`, configure provider-specific credentials/endpoints there, and select any provider/model present in pi-ai's installed catalog.

The [Python SDK tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md) provides an ordered installation and first-run path without the Web UI. The [`jsonrpc-agent` example](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/jsonrpc-agent/README.md) owns the complete standalone Cordis file used there.

`Session.run()` owns an activity interval from its prompt's durable inbox receipt through the next whole-agent idle and returns `RunResult(session_id, final_response, finish_reason, events, notifications)`. `final_response` is the last committed root-session assistant text in the interval. `finish_reason` is the `kind` of the last root-session `turn/end` in the interval, such as `completed`, `max-tokens`, or `error`, and is `None` when no turn ended. A `turn/end` without a string `data.reason.kind` violates the runtime protocol and raises `SdkProtocolError`. Both result fields describe the owned interval rather than an output or ending causally assigned to the prompt. Steering, injected context, and other queued work may contribute before idle.

`HarnessClient` retains discovered subagent ancestry while each child is active, releases an edge after `subagent.finished`, and bounds the lineage map by the notification queue limit. During each `Session.run()`, `RunResult.notifications` and `on_notification` receive the root session and all known descendant notifications in wire order, including nested subagent lifecycle and session events. `RunResult.events` contains root-session events only, so descendant messages cannot replace the root response. The low-level `session_prompt()` returns the queued `MessageId` immediately; callers that bypass `Session.run()` own any later activity boundary themselves.

`dsh_bin` selects an explicit executable; omitting it resolves the bundled runtime. Patch paths and the Harness home resolve before launch. The same options apply to `HarnessClient`; generic fake-process arguments are internal test support. See the [sdk-runtime README](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk-runtime/README.md) for production and development carriers.

`cwd` and `runtime_cwd` resolve to absolute paths before subprocess launch and the wire handshake. Input lines, pending requests, incoming requests, notifications, and output are bounded by `HarnessConfig`. Initialization, request, and shutdown timeouts must be positive finite seconds within the SDK timer bound. Persona and persistence settings belong to profile patches; the SDK returns results without choosing a storage directory.
