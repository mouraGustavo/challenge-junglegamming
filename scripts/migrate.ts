import 'reflect-metadata';
import { createOrm } from '../src/persistence/orm';
import { migrate } from '../src/persistence/migrate';

async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  if (!['up', 'down', 'status'].includes(direction)) throw new Error('Use up, down ou status');
  if (direction === 'down' && !process.argv.includes('--allow-data-loss')) {
    throw new Error('Rollback exclui dados. Use down --allow-data-loss apenas em banco descartável.');
  }
  const orm = await createOrm();
  try {
    const applied = await migrate(orm, direction as 'up' | 'down' | 'status');
    console.log(JSON.stringify({ event: 'migrations', direction, applied }));
  } finally { await orm.close(true); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
