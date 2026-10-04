/**
 * Source-plane stand-in for the generated terminal Remote contribution. The
 * real descriptors exist only in built `lib/`, so vitest configs alias the
 * `/remote` specifier here to keep `src/client/index.ts` resolvable. Client
 * test assemblies provide `remote.terminal` through the module's
 * `remoteNamespaces` export, so this module loads only when an assembly
 * triggers the self-mount without providing the namespace — a composition
 * error worth naming at import rather than a resolution failure.
 */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** Throws at evaluation: the generated contribution requires the artifact plane. */
const remote: TypertRemoteContribution = (() => {
  throw new Error(
    '@deepseek-ai/dsh-api-terminal-controller/remote resolved to its source-plane stand-in: '
    + 'the generated contribution exists only in built lib/; test assemblies provide remote.terminal '
    + 'through the client module remoteNamespaces export',
  )
})()

export default remote
