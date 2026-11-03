/** Isolated browser operations delegate every extension inference request to the host. */

import { parentPort, workerData } from 'node:worker_threads'
import { ClientLLMSchema } from '@browserbasehq/stagehand'
import type { ClientLLM } from '@browserbasehq/stagehand'
import { z } from 'zod'
import { browserInputs, openNativeBrowser, stagehandModelSchema } from './native.ts'
import { answer, request } from './worker-rpc.ts'

const port = parentPort
if (port === null) throw new Error('Stagehand attachment requires a Worker parent')
const { extensionId, cdpEndpoint, executablePath, ...config } = z.object({
  model: stagehandModelSchema,
  mode: z.enum(['launch', 'attach']),
  cdpEndpoint: z.string().optional(),
  executablePath: z.string().optional(),
  extensionId: z.string().optional(),
  headless: z.boolean(),
  operationTimeoutMs: z.number().int().positive(),
  shutdownGraceMs: z.number().int().positive(),
}).parse(workerData)
const methodSchema = z.enum(Object.keys(browserInputs) as [keyof typeof browserInputs, ...Array<keyof typeof browserInputs>])
const generate = ClientLLMSchema.shape.generate.implementAsync(async (input) => {
  // The public SDK wrapper validates the host reply before publishing it to the extension.
  return await request(port, 'model', input) as Awaited<ReturnType<ClientLLM['generate']>>
})
const opening = openNativeBrowser(
  {
    ...config, ...extensionId === undefined ? {} : { extensionId },
    ...cdpEndpoint === undefined ? {} : { cdpEndpoint },
    ...executablePath === undefined ? {} : { executablePath },
  }, {
    generate: async input => await generate(input),
  },
)
// Initialization failure stays observable through the host's ready request.
void opening.catch((error: unknown) => { void error })
port.on('message', (raw: unknown) => {
  void answer(raw, async (method, args) => {
    const native = await opening
    if (method === 'ready') return
    if (method === 'close') return native.close()
    return native.execute(methodSchema.parse(method), args)
  }).catch((error: unknown) => {
    console.error('Stagehand Worker protocol failed:', error)
    process.exit(1)
  })
})
