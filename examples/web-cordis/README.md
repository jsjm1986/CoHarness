# web-cordis

English | [中文](README.zh.md)

Read-only [Cordis runtime inspection](../../packages/extensions/tool-cordis/README.md) through the shipped Web or ACP profile. The Agent discovers exact Host APIs; Web also supplies live Client APIs and Slot information. The demo does not expose model tools for executing dynamic Plugin code.

## Run it

Start the browser interface:

```sh
pnpm run demo:cordis
```

Start the ACP automation server instead:

```sh
pnpm run demo:cordis acp
```

Both commands use the normal `dsh` profile launcher with an inspection overlay. Model conversations require `DEEPSEEK_API_KEY`. Ask the Agent to list inspection providers, query the Tool provider, and describe the available read-only APIs. Persistent Plugin changes belong to Creator mode and Plugin Manager's authorized installation workflow.
