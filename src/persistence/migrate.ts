import type { MikroORM } from '@mikro-orm/postgresql';
import { migration001 } from './migrations/001-financial-schema';

const migrations = [migration001];
export async function migrate(orm: MikroORM, direction: 'up' | 'down' | 'status'): Promise<string[]> {
  return orm.em.fork().transactional(async (em) => {
    const execute = (sql: string, params: unknown[] = []): Promise<unknown> =>
      em.getConnection().execute(sql, params, 'all', em.getTransactionContext());
    // Exclusivo à administração do schema, nunca usado em operações de wallets.
    await execute('select pg_advisory_xact_lock(734291001)');
    await execute('create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    const applied = await execute('select id from schema_migrations order by id') as { id: string }[];
    const ids = applied.map((row) => row.id);
    if (ids.some((id) => !migrations.some((migration) => migration.id === id))) {
      throw new Error('UNKNOWN_MIGRATION: banco está à frente deste código');
    }
    if (direction === 'status') return ids;
    if (direction === 'up') {
      for (const migration of migrations) {
        if (ids.includes(migration.id)) continue;
        await execute(migration.up);
        await execute('insert into schema_migrations(id) values (?)', [migration.id]);
      }
    } else {
      const latest = migrations.find((migration) => migration.id === ids.at(-1));
      if (latest) {
        await execute(latest.down);
        await execute('delete from schema_migrations where id = ?', [latest.id]);
      }
    }
    const after = await execute('select id from schema_migrations order by id') as { id: string }[];
    return after.map((row) => row.id);
  });
}
