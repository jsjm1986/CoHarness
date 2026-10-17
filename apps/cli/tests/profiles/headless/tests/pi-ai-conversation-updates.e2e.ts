import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

interface JsonObject {
  [key: string]: unknown
}

const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const piAiConversationUpdatesConfigPath = fileURLToPath(new URL('./fixtures/pi-ai-conversation-updates.patch.yml', import.meta.url))

interface ConversationServer {
  url: string
  requests: JsonObject[]
  close: () => Promise<void>
}

/** Script Chat Completions responses in request order: `read`, then `snapshot_ping`, then text. */
async function piAiConversationServer(): Promise<ConversationServer> {
  const requests: JsonObject[] = []
  const agentReplies = [
    { tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read', arguments: '{"file_path":"task.txt"}' } }] },
    { tool_calls: [{ index: 0, id: 'call_ping', type: 'function', function: { name: 'snapshot_ping', arguments: '{}' } }] },
    { content: 'DONE' },
  ]
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as JsonObject)
      const delta = agentReplies[requests.length - 1] ?? { content: 'UNEXPECTED' }
      const finish = 'tool_calls' in delta ? 'tool_calls' : 'stop'
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n'))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('pi-ai conversation snapshot server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

/** Project one Chat Completions request to its fixture-owned declarations and message roles, tools, and prompt markers. */
function piAiTranscript(request: JsonObject): JsonObject {
  const names = (tools: unknown): string[] => Array.isArray(tools)
    ? tools.map(tool => ((tool as { function: { name: string } }).function.name))
    : []
  return {
    // Profile tools change independently of this scenario; only the fixture's tool is recorded.
    tools: names(request.tools).filter(name => name === 'snapshot_ping'),
    messages: (request.messages as JsonObject[]).map(message => ({
      role: message.role,
      ...message.tools === undefined ? {} : { tools: names(message.tools) },
      ...typeof message.content === 'string' && message.content.includes('Dynamic tool guidance') ? { guidance: true } : {},
    })),
  }
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

describe('headless pi-ai conversation updates snapshot', () => {
  it('sends pi-ai Kimi prompt and tool updates in conversation history', async () => {
    const server = await piAiConversationServer()
    try {
      const result = await runLoaderSmoke({
        label: 'pi-ai Kimi conversation updates headless stream-json snapshot',
        tempDirPrefix: 'headless-snapshot-pi-ai-conversation-updates-',
        binScript,
        libBinScript: binScript,
        configPath: piAiConversationUpdatesConfigPath,
        binArgs: [
          piAiConversationUpdatesConfigPath,
          'read task.txt and follow it',
        ],
        tsconfigPath,
        prepare: cwd => writeFile(join(cwd, 'task.txt'), 'Call snapshot_ping once.\n'),
        env: {
          MOONSHOT_API_KEY: 'snapshot-key',
          DSH_SNAPSHOT_BASE_URL: server.url,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        },
      })

      expect(result.stderr).toBe('')
      expect(parseJsonl(result.stdout).at(-1)).toMatchObject({ type: 'result', output: 'DONE' })
      expect(server.requests.map(piAiTranscript)).toMatchInlineSnapshot(`
        [
          {
            "messages": [
              {
                "role": "system",
              },
              {
                "role": "user",
              },
              {
                "role": "user",
              },
            ],
            "tools": [],
          },
          {
            "messages": [
              {
                "role": "system",
              },
              {
                "role": "user",
              },
              {
                "role": "user",
              },
              {
                "role": "assistant",
              },
              {
                "role": "tool",
              },
              {
                "guidance": true,
                "role": "system",
              },
              {
                "role": "system",
                "tools": [
                  "snapshot_ping",
                ],
              },
            ],
            "tools": [],
          },
          {
            "messages": [
              {
                "role": "system",
              },
              {
                "role": "user",
              },
              {
                "role": "user",
              },
              {
                "role": "assistant",
              },
              {
                "role": "tool",
              },
              {
                "guidance": true,
                "role": "system",
              },
              {
                "role": "assistant",
              },
              {
                "role": "tool",
              },
            ],
            "tools": [],
          },
        ]
      `)
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
