/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { McpProcessOwner } from './managed-stdio.ts'
import type { Config } from './index.ts'

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param processes - Required local process owner for stdio; HTTP needs no child process.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, processes?: McpProcessOwner): Transport {
  switch (config.transport) {
    case 'stdio':
      if (processes === undefined) throw new Error('MCP stdio transport requires its managed process owner')
      return processes.transport()
    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      )
  }
}
