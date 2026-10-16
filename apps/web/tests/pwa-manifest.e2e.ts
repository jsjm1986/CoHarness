import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  const official = index.includes('<title>DeepSeek Harness</title>')
  const expectedName = official ? 'DeepSeek Harness' : 'COHARNESS'
  const expectedShortName = official ? 'DSH' : 'COHARNESS'
  expect(manifest).toEqual({
    id: '/',
    name: expectedName,
    short_name: expectedShortName,
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships a favicon that switches to a light mark under dark color scheme', async () => {
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  if (favicon.includes('class="arc"')) {
    expect(favicon).toContain('#2563eb')
    expect(favicon).toContain('#6b93ff')
    expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)/)
    return
  }
  // The official mark's light fill must live inside the dark-scheme media
  // query, so it stays black in light mode and turns white only in dark mode.
  expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*path\s*{[^}]*fill:\s*#fff/i)
  expect(favicon).toContain('fill="#000"')
})
