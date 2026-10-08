/** Hosted APT repository rewrites preserve metadata and enforce bounded networking. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NETWORK_POLICY, prepareHostedApt } from './prepare-ci-apt.mjs'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fixture(files: Record<string, string | Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ci-apt-'))
  roots.push(dir)
  mkdirSync(join(dir, 'apt.conf.d'))
  for (const [name, content] of Object.entries(files)) {
    if (typeof content === 'string') {
      writeFileSync(join(dir, name), content)
    } else {
      mkdirSync(join(dir, name), { recursive: true })
      for (const [entry, text] of Object.entries(content)) writeFileSync(join(dir, name, entry), text)
    }
  }
  return dir
}

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8')

const EXPECTED_POLICY = [
  'Acquire::http::Timeout "20";',
  'Acquire::https::Timeout "20";',
  'Acquire::Retries "0";',
  'Acquire::Languages "none";',
  'APT::Update::Error-Mode "any";',
  'DPkg::Lock::Timeout "30";',
  '',
].join('\n')

describe('prepareHostedApt', () => {
  it('writes exactly the independent six-line bounded network policy', () => {
    const dir = fixture({})
    prepareHostedApt(dir)
    expect(NETWORK_POLICY).toBe(EXPECTED_POLICY)
    expect(read(dir, 'apt.conf.d/98-dsh-ci-network')).toBe(EXPECTED_POLICY)
  })

  it('rewrites the mirror list to the canonical archive, preserving order and priorities', () => {
    const input = [
      'http://azure.archive.ubuntu.com/ubuntu priority:1',
      'https://mirror.azure.example/ubuntu priority:2',
      'mirror+file:/srv/mirror/ubuntu priority:3',
      '',
    ].join('\n')
    const dir = fixture({ 'apt-mirrors.txt': input })
    expect(prepareHostedApt(dir)).toEqual([join(dir, 'apt-mirrors.txt'), join(dir, 'apt.conf.d', '98-dsh-ci-network')])
    expect(read(dir, 'apt-mirrors.txt')).toBe([
      'https://archive.ubuntu.com/ubuntu/ priority:1',
      'https://mirror.azure.example/ubuntu priority:2',
      'mirror+file:/srv/mirror/ubuntu priority:3',
      '',
    ].join('\n'))
  })

  it('upgrades amd64 legacy .list URIs while the bracketed arch and signed-by stay verbatim', () => {
    const input = 'deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse\n'
    const dir = fixture({ 'sources.list': input })
    prepareHostedApt(dir)
    expect(read(dir, 'sources.list')).toBe(
      'deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main restricted universe multiverse\n',
    )
  })

  it('rewrites a Deb822 amd64 Azure stanza differing only in the URI', () => {
    const input = [
      'Types: deb',
      'URIs: https://azure.archive.ubuntu.com/ubuntu',
      'Suites: noble noble-updates',
      'Components: main restricted',
      'Architectures: amd64',
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
      '',
    ].join('\n')
    const dir = fixture({ 'sources.list.d': { 'ubuntu.sources': input } })
    const changed = prepareHostedApt(dir)
    expect(changed).toEqual([join(dir, 'sources.list.d', 'ubuntu.sources'), join(dir, 'apt.conf.d', '98-dsh-ci-network')])
    expect(read(dir, 'sources.list.d/ubuntu.sources')).toBe(input.replace('URIs: https://azure.archive.ubuntu.com/ubuntu', 'URIs: https://archive.ubuntu.com/ubuntu/'))
  })

  it('upgrades arm64 ports URIs inside Deb822 .sources while preserving signing', () => {
    const input = [
      'Types: deb',
      'URIs: http://ports.ubuntu.com/ubuntu-ports',
      'Suites: noble noble-updates',
      'Components: main restricted',
      'Architectures: arm64',
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
      '',
    ].join('\n')
    const dir = fixture({ 'sources.list.d': { 'ubuntu.sources': input } })
    prepareHostedApt(dir)
    expect(read(dir, 'sources.list.d/ubuntu.sources')).toBe(input.replace('http:', 'https:'))
  })

  it('leaves Microsoft and unrelated repositories byte-for-byte', () => {
    const content = 'deb [signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main\n'
    const dir = fixture({ 'sources.list.d': { 'microsoft-edge.list': content } })
    expect(prepareHostedApt(dir)).toEqual([join(dir, 'apt.conf.d', '98-dsh-ci-network')])
    expect(read(dir, 'sources.list.d/microsoft-edge.list')).toBe(content)
  })

  it('tolerates a missing optional sources.list and sources.list.d', () => {
    const dir = fixture({})
    expect(prepareHostedApt(dir)).toEqual([join(dir, 'apt.conf.d', '98-dsh-ci-network')])
  })

  it('is idempotent: a repeat preparation writes nothing', () => {
    const dir = fixture({ 'sources.list': 'deb http://archive.ubuntu.com/ubuntu noble main\n' })
    prepareHostedApt(dir)
    expect(prepareHostedApt(dir)).toEqual([])
  })

  it('propagates a source directory IO failure', () => {
    const dir = fixture({})
    writeFileSync(join(dir, 'sources.list.d'), 'not a directory\n')
    expect(() => prepareHostedApt(dir)).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects an existing dangling sources.list before writing policy', () => {
    const dir = fixture({})
    symlinkSync(join('nonexistent', 'target.list'), join(dir, 'sources.list'))
    expect(() => prepareHostedApt(dir)).toThrow()
    expect(existsSync(join(dir, 'apt.conf.d', '98-dsh-ci-network'))).toBe(false)
  })
})
