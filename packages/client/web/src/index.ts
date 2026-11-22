/**
 * Web shell library with the boot entry and synchronous platform table.
 * The product loads {@link AppWebEntry} from `./boot` so startup input can
 * render while the platform modules load.
 * @module @deepseek-ai/dsh-client-web
 */

export { AppWebEntry, type BootSeams } from './boot.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS, type PlatformModule } from './platform.ts'
export { applyIndexInjections } from './apply-injections.ts'
