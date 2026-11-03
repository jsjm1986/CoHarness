/** Source-launched child receives its reservation only through private IPC. */
import { LocalRuntimeOwnerLease, LocalRuntimeOwnerStore } from '../../src/local-runtime-owner.ts'

process.once('message', async (message: unknown) => {
  if (message === null || typeof message !== 'object' || !('directory' in message) || typeof message.directory !== 'string'
    || !('record' in message) || message.record === null || typeof message.record !== 'object' || !('identity' in message.record)) {
    throw new Error('Invalid owned lease fixture startup')
  }
  const owner = new LocalRuntimeOwnerStore(message.directory, message.record.identity)
  await LocalRuntimeOwnerLease.inherit(owner, 4, message.record)
  process.stdout.write('ready')
  setInterval(() => {}, 1000)
})
