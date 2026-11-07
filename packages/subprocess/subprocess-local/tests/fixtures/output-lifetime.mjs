/** Isolated process ownership of the lazy default spill directory. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [entry, keepFile] = process.argv.slice(2)
const baseline = process.listenerCount('exit')
const output = await import(entry)
const importedHooks = process.listenerCount('exit') - baseline
output.prepareManagedProcessBinding({ spillDir: process.cwd() })
const customHooks = process.listenerCount('exit') - baseline
const first = output.prepareManagedProcessBinding(), second = output.prepareManagedProcessBinding()
if (keepFile === 'yes') writeFileSync(join(first.spillDir, 'completed.txt'), 'retained output')
console.log(JSON.stringify({ importedHooks, customHooks, defaultHooks: process.listenerCount('exit') - baseline,
  sameDirectory: first.spillDir === second.spillDir, directory: first.spillDir }))
