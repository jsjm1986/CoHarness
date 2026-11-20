/** Build and verify every repository-owned production payload. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { ensureGatewayRuntimePackages, gatewayRuntimePackageLinksValid } from './gateway-runtime-packages.ts'
import { verifyReleaseRuntimeDigest, writeReleaseRuntimeDigest } from '../gateway/src/runtime-dependency-fingerprint.ts'

interface BuildStep {
  label: string
  cwd: string
  args: string[]
}

const root = resolve(import.meta.dirname, '..')
function run(step: BuildStep): void {
  console.log(`build-production: ${step.label}`)
  const invocation = pnpmInvocation(step.args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: step.cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`build-production: ${step.label} failed with exit code ${String(result.status)}`)
  }
}

function requireFile(path: string, failures: string[]): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) failures.push(path)
}

function requireAsset(directory: string, suffix: string, failures: string[]): void {
  if (!existsSync(directory) || !readdirSync(directory).some(file => file.endsWith(suffix))) {
    failures.push(`${directory}/*${suffix}`)
  }
}

function verifyArtifacts(): void {
  const failures: string[] = []
  const paths = readFileSync(resolve(root, 'gateway/deploy/required-release-files.txt'), 'utf8').replace(/\n$/u, '').split('\n')
  if (!paths.includes('gateway/lib/local-runtime-supervisor.js') || paths.some(path =>
    !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/u.test(path) || path.split('/').some(segment => segment === '..' || segment === '.' || segment === ''))) {
    throw new Error('build-production: invalid Gateway release manifest')
  }
  for (const path of paths) requireFile(resolve(root, path), failures)
  if (!gatewayRuntimePackageLinksValid(root)) {
    failures.push(resolve(root, 'gateway/node_modules/@deepseek-ai'))
  }
  requireAsset(resolve(root, 'apps/web/dist/assets'), '.js', failures)
  requireAsset(resolve(root, 'apps/web/dist/assets'), '.css', failures)
  requireAsset(resolve(root, 'gateway/public/admin/assets'), '.js', failures)
  requireAsset(resolve(root, 'gateway/public/admin/assets'), '.css', failures)
  if (failures.length > 0) {
    throw new Error(`build-production: missing or empty production payloads:\n${failures.join('\n')}`)
  }
  console.log('build-production: verified Harness, Web, Gateway, Admin UI, and plugin payloads')
}

const verifyOnly = process.argv.includes('--verify-only')
if (!verifyOnly) {
  const steps: BuildStep[] = [
    { label: 'Harness libraries and Web', cwd: root, args: ['run', 'build', '--force-emit'] },
    {
      label: 'directory guard plugin',
      cwd: resolve(root, 'plugins/dsh-directory-guard'),
      args: ['run', 'build'],
    },
    {
      label: 'model governance plugin',
      cwd: resolve(root, 'plugins/dsh-model-governance'),
      args: ['run', 'build'],
    },
    {
      label: 'steward tools plugin',
      cwd: resolve(root, 'plugins/dsh-steward-tools'),
      args: ['run', 'build'],
    },
    { label: 'Gateway artifact', cwd: resolve(root, 'gateway'), args: ['run', 'build'] },
    { label: 'Gateway typecheck', cwd: resolve(root, 'gateway'), args: ['run', 'typecheck'] },
    { label: 'Gateway built document authority', cwd: resolve(root, 'gateway'), args: ['run', 'test:built-document-authority'] },
    { label: 'Gateway built document maintenance', cwd: resolve(root, 'gateway'), args: ['run', 'test:built-document-maintenance'] },
    { label: 'Admin UI', cwd: resolve(root, 'gateway/admin-ui'), args: ['run', 'build'] },
  ]
  for (const step of steps) {
    if (step.label === 'Gateway artifact') ensureGatewayRuntimePackages(root)
    run(step)
  }
  writeReleaseRuntimeDigest(root)
}

verifyArtifacts()
if (verifyOnly) verifyReleaseRuntimeDigest(root)
