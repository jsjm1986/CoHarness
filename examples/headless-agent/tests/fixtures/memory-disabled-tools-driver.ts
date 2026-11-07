/** File settings withdraw model scopes while owner reads retain durable memories. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { MEMORY_SETTINGS_NAMESPACE, memoryScopeId } from '@deepseek-ai/dsh-memory'
import type { MemoryScope } from '@deepseek-ai/dsh-memory'

const [path, space] = process.argv.slice(2)
assert.ok(path !== undefined && (space === 'personal' || space === 'project'))
const scopes: MemoryScope[] = space === 'project' ? [{ kind: 'project' }]
  : [{ kind: 'personal' }, { kind: 'workspace', directory: process.cwd() }]
const table = join(process.cwd(), '.memory-store', 'memory', 'entries')
await mkdir(table, { recursive: true })
for (const scope of scopes) {
  const attribution = { source: 'member', at: '2026-10-01T00:00:00.000Z' }
  await writeFile(join(table, `${memoryScopeId(scope)}_release-rule.json`), JSON.stringify({ version: 1, record: {
    scope, key: 'release-rule', kind: 'guidance', summary: 'Member guidance', content: 'Stored member guidance.',
    revision: `seed-${scope.kind}`, created: attribution, updated: attribution,
  } }))
}
const ctx = await boot('memory-disabled-tools', resolveConfigPath(path, undefined))
try {
  assert.equal(ctx.memory.space, space)
  while (ctx.agents.roots().length === 0) await delay(10)
  const agent = ctx.agents.roots()[0]
  assert.ok(agent !== undefined)
  for (const enabled of [false, true]) {
    await ctx.settings.update(MEMORY_SETTINGS_NAMESPACE, { enabled })
    const phase = enabled ? 'on' : 'off'
    assert.equal(ctx.memory.switches().enabled, enabled)
    const calls = new Map<string, string>()
    const outcomes: { failed: boolean; code: string | undefined }[] = []
    const result = await runFixtureTurn(ctx, { task: enabled ? 'MEMORY_TOOLS_ON' : 'MEMORY_TOOLS_OFF',
      onEvent: (_sessionId, event) => {
        if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
        if (event.type !== 'tool/result') return
        const message = event.data.message
        outcomes.push({ failed: message.isError === true, code: event.data.error?.code })
        process.stdout.write(JSON.stringify({ type: 'tool', phase, name: calls.get(message.toolCallId),
          isError: message.isError === true, code: event.data.error?.code ?? null,
          text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }) + '\n')
      },
    })
    assert.equal(result.output, 'Done.')
    assert.ok(outcomes.length > 0 && outcomes.every(value => value.failed === !enabled))
    assert.ok(outcomes.every(value => value.code === (enabled ? undefined : 'memory_invalid')))
    for (const scope of scopes) {
      const entry = await ctx.memory.memberRead({ scope, key: 'release-rule' })
      assert.ok(entry !== undefined)
      assert.equal(entry.content, 'Stored member guidance.')
      assert.equal(entry.revision, `seed-${scope.kind}`)
      assert.equal((await ctx.memory.entries(scope)).length, 1)
      process.stdout.write(JSON.stringify({ type: 'owner', phase, scope: scope.kind, content: entry.content }) + '\n')
    }
  }
} finally { await ctx.fiber.dispose() }
