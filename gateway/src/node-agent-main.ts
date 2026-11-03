/** Node-agent CLI for both source and built deployments. */
import { nodeAgentFailureMessage, NodeAgentError, runNodeAgent } from './node-agent.ts'
import { configuredNodeAgent } from './node-connection.ts'

const shutdown = new AbortController()
const stop = (): void => { shutdown.abort() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
let codeErasure: Promise<void> | undefined
try {
  const configured = await configuredNodeAgent(process.env)
  const { config } = configured
  delete process.env.HGW_NODE_ENROLLMENT_TOKEN
  await runNodeAgent(config, shutdown.signal, event => {
    if (event.status === 'enrolled') codeErasure = configured.clearCode().catch(() => {
      process.stderr.write(JSON.stringify({ status: 'failed', reason: 'node-agent/code-erasure-failed',
        message: 'The enrollment code could not be cleared from private setup. Check file permissions before restarting the agent.' }) + '\n')
      process.exitCode = 1
      shutdown.abort()
    })
    const diagnostic = event.status === 'degraded' ? { ...event, message: nodeAgentFailureMessage(event.reason) }
      : event.status === 'channel-degraded' ? { ...event, message: 'The node control channel is unavailable. Heartbeat supervision continues; check the network and center release before using node services.' }
      : event.status === 'stopped-lease-uncertain' ? { ...event, message: 'The center has not confirmed connection release. Check the center directory; its lease will expire without further heartbeats.' }
        : event
    process.stdout.write(JSON.stringify(diagnostic) + '\n')
    if (event.status === 'stopped-lease-uncertain') process.exitCode = 1
  })
} catch (error) {
  if (!shutdown.signal.aborted) {
    process.stderr.write(JSON.stringify({ status: 'failed', reason: error instanceof NodeAgentError ? error.code : 'node-agent/local-failure',
      message: error instanceof NodeAgentError ? error.message : 'The node agent could not finish a local operation. Check its state-file permissions and available disk space before restarting.' }) + '\n')
    process.exitCode = 1
  }
} finally {
  await codeErasure
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
