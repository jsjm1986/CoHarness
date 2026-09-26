/** Model guidance for read-only runtime and session-owned package discovery. */
export const CORDIS_SYSTEM_PROMPT = `# Harness runtime inspection

Use cordis_inspect_list to discover Host and Client providers, then cordis_inspect_query to read exact Service, Event, Tool, Theme or Slot APIs. These tools are read-only; queries do not invoke business methods.

Use cordis_inspect_self to inspect existing session-owned Plugin summaries, version pointers, or an exact Package's source and diagnostics. An explicit @pluginId reference identifies an inspection target; it does not authorize execution or modification. Dynamic definitions remain process-local and may be unavailable after restart.

For a requested persistent Plugin or MCP change, load the cordis-plugin-development Skill and use Plugin Manager's authorized installation workflow. Inspect results describe APIs; they are not business data or an alternative execution path.`
