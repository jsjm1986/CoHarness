/** Native FIFO rejection through the actual source configuration reader. */
import { readNodeConfiguration } from '../../src/node-config-store.ts'
console.log('reading-node-configuration')
try {
  await readNodeConfiguration(process.argv[2], {})
  console.log(JSON.stringify({ resolved: true }))
} catch (error) {
  console.log(JSON.stringify({ status: error.status, error: error.message }))
}
