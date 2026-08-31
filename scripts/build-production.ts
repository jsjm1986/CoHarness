/** Build and verify every repository-owned production payload. */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

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

/**
 * Make the standalone Gateway's compiled ESM graph resolve the one workspace
 * package it imports at runtime. The Gateway is intentionally outside the
 * pnpm workspace, so a clean git-archive release does not get pnpm's usual
 * workspace symlink automatically. The relative link keeps the release
 * self-contained and survives copying the complete release directory.
 */
function ensureGatewayRuntimePackage(): void {
  const packageRoot = resolve(root, 'packages/llm/llm')
  const packageManifest = join(packageRoot, 'package.json')
  const packageEntry = join(packageRoot, 'lib/types/discovery.js')
  if (!existsSync(packageManifest) || !existsSync(packageEntry)) {
    throw new Error(`build-production: Gateway runtime package is incomplete: ${packageRoot}`)
  }
  const link = resolve(root, 'gateway/node_modules/@deepseek-ai/dsh-llm')
  mkdirSync(dirname(link), { recursive: true })
  const expected = realpathSync(packageRoot)
  const existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing !== undefined) {
    const actual = realpathSync(link)
    if (actual !== expected) {
      throw new Error(`build-production: Gateway runtime package link points to ${actual}, expected ${expected}`)
    }
    return
  }
  symlinkSync(relative(dirname(link), packageRoot), link, 'dir')
}

/** Verify the release-local Gateway package link without mutating a verify-only run. */
function gatewayRuntimePackageLinkValid(): boolean {
  const packageRoot = resolve(root, 'packages/llm/llm')
  const link = resolve(root, 'gateway/node_modules/@deepseek-ai/dsh-llm')
  try {
    return realpathSync(link) === realpathSync(packageRoot)
  } catch {
    return false
  }
}

function verifyArtifacts(): void {
  const failures: string[] = []
  for (const path of [
    'apps/cli/lib/bin.js',
    'apps/web/dist/index.html',
    'gateway/lib/index.js',
    'gateway/lib/config.js',
    'gateway/lib/server.js',
    'gateway/lib/runtime-api.js',
    'gateway/public/admin/index.html',
    'gateway/deploy/postgres/migrations/003_project_collaboration.sql',
    'gateway/deploy/postgres/migrations/004_conversation_event_json.sql',
    'gateway/deploy/postgres/migrations/005_user_owned_projects.sql',
    'gateway/deploy/postgres/migrations/014_usage_attribution_status.sql',
    'plugins/dsh-directory-guard/lib/index.js',
    'plugins/dsh-directory-guard/cordis.patch.yml',
    'plugins/dsh-directory-guard/cordis.admin.patch.yml',
    'plugins/dsh-model-governance/lib/index.js',
    'plugins/dsh-model-governance/lib/outbox.js',
    'plugins/dsh-model-governance/cordis.patch.yml',
    'packages/context/archive-gateway/lib/index.js',
    'packages/context/archive-gateway/lib/invariant.js',
  ]) requireFile(resolve(root, path), failures)
  if (!gatewayRuntimePackageLinkValid()) {
    failures.push(resolve(root, 'gateway/node_modules/@deepseek-ai/dsh-llm'))
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

if (!process.argv.includes('--verify-only')) {
  const steps: BuildStep[] = [
    { label: 'Harness libraries and Web', cwd: root, args: ['run', 'build'] },
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
    { label: 'Gateway artifact', cwd: resolve(root, 'gateway'), args: ['run', 'build'] },
    { label: 'Gateway typecheck', cwd: resolve(root, 'gateway'), args: ['run', 'typecheck'] },
    { label: 'Admin UI', cwd: resolve(root, 'gateway/admin-ui'), args: ['run', 'build'] },
  ]
  for (const step of steps) {
    if (step.label === 'Gateway artifact') ensureGatewayRuntimePackage()
    run(step)
  }
}

verifyArtifacts()
