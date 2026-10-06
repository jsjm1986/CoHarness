/**
 * Source-plane stand-in for the generated terminal Remote contribution. Vite
 * resolves the `/remote` specifier here ahead of package exports; when the
 * built `lib/` artifact exists — the real-API e2e lane builds it first — this
 * module delegates to it so a self-mount exercises the real descriptors.
 * Otherwise it throws at evaluation: test assemblies without the artifact
 * provide `remote.terminal` through the client module `remoteNamespaces`
 * export, and reaching this module means an assembly triggered the self-mount
 * without one — a composition error worth naming at import rather than a
 * resolution failure.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const artifactUrl = new URL('../lib/typert.remote-client.js', import.meta.url)

/**
 * Generated contribution from `lib/` when built; throws at evaluation when the
 * artifact is absent and the self-mount has nothing real to mount.
 */
const remote: TypertRemoteContribution = existsSync(fileURLToPath(artifactUrl))
  ? ((await import(artifactUrl.href)) as { default: TypertRemoteContribution }).default
  : (() => {
    throw new Error(
      '@deepseek-ai/dsh-api-terminal-controller/remote resolved to its source-plane stand-in: '
      + 'the generated contribution exists only in built lib/; test assemblies provide remote.terminal '
      + 'through the client module remoteNamespaces export',
    )
  })()

export default remote
