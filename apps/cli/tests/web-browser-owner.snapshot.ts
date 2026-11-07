/** Shipped Web CLI ownership over a real native opener helper without a desktop browser. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const bin = join(repository, 'apps/cli/lib/bin.js')
const frontend = join(repository, 'apps/web/dist/index.html')
if (!existsSync(bin) || !existsSync(frontend)) throw new Error('Browser owner regression requires built CLI and frontend artifacts')

it('joins the native opener before acknowledging Web runtime removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-browser-owner-'))
  try {
    const patch = join(root, 'owner.patch.yml')
    writeFileSync(patch, JSON.stringify([{ insertAfter: 'web-runtime', insert: [{ id: 'browser-owner-probe',
      name: new URL('./fixtures/web-browser-owner/controller.mjs', import.meta.url).href }] }]))
    const result = await execa(process.execPath, ['--import', new URL('./fixtures/web-browser-owner/register.mjs', import.meta.url).href,
      bin, '--profile', 'web', '--patch', patch, '--port', '0'], { cwd: root, input: '', timeout: 60_000,
      killSignal: 'SIGKILL', reject: false, env: { ...process.env,
        NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
        DEEPSEEK_API_KEY: 'keyless-browser-owner-no-call', DSH_AGENTS_HOME: join(root, '.agents'),
        DSH_HOME: join(root, '.dsh'), DSH_TELEMETRY_DISABLED: '1', HOME: root, USERPROFILE: root,
        NODE_NO_WARNINGS: '1', SSH_CONNECTION: '', SSH_TTY: '',
      } })
    const row = result.stdout.split('\n').find(line => line.startsWith('web-browser-owner: '))
    if (row === undefined) throw new Error(`Browser owner observation missing: ${result.stderr}`)
    expect({ exitCode: result.exitCode, ...JSON.parse(row.slice('web-browser-owner: '.length)) }).toMatchInlineSnapshot(`
      {
        "exitCode": 0,
        "helperInitiallyAlive": true,
        "helperStoppedAfterCleanup": true,
        "helperStoppedBeforeOwnerAck": true,
        "listenerRetained": true,
      }
    `)
  } finally {
    writeFileSync(join(root, 'browser-release'), 'released')
    rmSync(root, { recursive: true, force: true })
  }
}, 70_000)
