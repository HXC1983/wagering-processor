import { defineConfig } from '@mikro-orm/postgresql';
import { allSchemas } from '../persistence/schemas';
import { Migration20261023000001 } from './migrations/Migration20261023000001_initial_schema';

export const DEFAULT_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering';

export function buildOrmConfig() {
  return defineConfig({
    clientUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: allSchemas,
    discovery: { warnWhenNoEntities: false },
    migrations: {
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        { name: 'Migration20261023000001_initial_schema', class: Migration20261023000001 },
      ],
    },
  });
}
