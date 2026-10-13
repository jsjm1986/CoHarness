/** Directory collaborator for consumer-only tests with structural Agent stubs. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Supply fixed directory values without filesystem checks or durable changes.
 * @param ctx - context owning this test collaborator.
 * @param defaultDirectory - fallback for fixtures without a Session directory.
 */
export function provideWorkingDirectoryFixture(ctx: Context, defaultDirectory = process.cwd()): void {
  const directories = new WeakMap<Session, string>()
  const get = (session: Session | undefined): string => {
    const recorded = session === undefined ? undefined : directories.get(session)
    return recorded ?? session?.header.cwd ?? defaultDirectory
  }
  ctx.provide('workingDirectory', {
    defaultDirectory,
    get,
    ensure: (agent: Agent): Promise<string> => Promise.resolve(get(agent.session)),
    resolve: (agent: Agent, path: string): Promise<string> =>
      Promise.resolve(resolve(get(agent.session), path)),
    set: (agent: Agent, path: string): Promise<string> => {
      const cwd = resolve(get(agent.session), path)
      directories.set(agent.session, cwd)
      return Promise.resolve(cwd)
    },
  })
}
