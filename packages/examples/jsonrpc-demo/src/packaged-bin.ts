#!/usr/bin/env node
/**
 * Closed-runtime JSON-RPC agent bin. Bare plugins resolve from the installed
 * runtime closure while relative plugins remain configuration-relative.
 *
 * The packaged executable is also the worker carrier: the PTC Node runtime
 * and the private subprocess runner re-invoke it under their env selectors,
 * and the Windows ACL sandbox runner passes its built entry through argv.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-demo/packaged-bin
 */

import { fileURLToPath } from 'node:url'

import { runJsonrpcAgent } from './runner.ts'

/* v8 ignore start -- exercised through the built Python runtime carriers */
const aclRunner = process.platform === 'win32'
  ? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  : undefined
if (aclRunner !== undefined && process.argv[2] === aclRunner) {
  process.argv.splice(1, 1)
  await import('@deepseek-ai/dsh-sandbox-windows-acl/runner')
} else if (process.env['DSH_PTC_RUNTIME_NODE'] === '1') {
  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
  await import('@deepseek-ai/dsh-ptc-runtime-node/process')
} else {
  const selection = process.env['DSH_SUBPROCESS_RUNNER']
  if (selection === undefined) {
    await runJsonrpcAgent(import.meta.url)
  } else {
    Reflect.deleteProperty(process.env, 'DSH_SUBPROCESS_RUNNER')
    const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
    await runSelectedSubprocessRunner(selection)
  }
}
/* v8 ignore stop */
