/** One external filesystem failure in a private helper, selected by its caller-owned marker file. */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync } from 'node:fs'

const filesystem = createRequire(import.meta.url)('node:fs/promises')
const original = filesystem.rm
let failed = false
filesystem.rm = async (path, options) => {
  let selected
  try { selected = readFileSync(process.env.DSH_TEST_SSH_CLEANUP_TARGET, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!failed && path === selected) {
    failed = true
    throw new Error('Fixture remote cleanup temporarily unavailable')
  }
  await original(path, options)
}
syncBuiltinESMExports()
