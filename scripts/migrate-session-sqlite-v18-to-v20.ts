import { migrateV18ToV20, runMigration } from './session-sqlite-migration.ts'

await runMigration(migrateV18ToV20)
