import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './mikro-orm.config';

const command = process.argv[2];

async function main(): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig());
  try {
    const migrator = orm.getMigrator<Migrator>();

    if (command === 'up') {
      const executed = await migrator.up();
      console.log(`Migrations aplicadas: ${executed.length}`);
      executed.forEach((m) => console.log(`  + ${m.name}`));
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`Migrations revertidas: ${reverted.length}`);
      reverted.forEach((m) => console.log(`  - ${m.name}`));
    } else if (command === 'pending') {
      const pending = await migrator.getPendingMigrations();
      console.log(`Migrations pendentes: ${pending.length}`);
      pending.forEach((m) => console.log(`  . ${m.name}`));
    } else {
      throw new Error('Uso: bun run src/infrastructure/database/migrate.ts <up|down|pending>');
    }
  } finally {
    await orm.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
