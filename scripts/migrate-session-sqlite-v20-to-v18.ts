import { migrateV20ToV18, runMigration } from './session-sqlite-migration.ts'

await runMigration(migrateV20ToV18)
