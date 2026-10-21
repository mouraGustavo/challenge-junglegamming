import { randomUUID } from 'node:crypto';
import { createOrm } from '../../src/persistence/orm';
import { migrate } from '../../src/persistence/migrate';
import { config } from '../../src/config';

export async function temporaryDatabase() {
  const dbName = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  const admin = await createOrm();
  let orm: Awaited<ReturnType<typeof createOrm>> | undefined;
  try {
    await admin.em.getConnection().execute(`create database "${dbName}"`);
    orm = await createOrm(true, { ...config.database, dbName });
    await migrate(orm, 'up');
    const database = orm;
    return { orm: database, dbName, async close() {
      await database.close(true);
      try { await admin.em.getConnection().execute(`drop database "${dbName}" with (force)`); }
      finally { await admin.close(true); }
    } };
  } catch (error) {
    await orm?.close(true);
    try { await admin.em.getConnection().execute(`drop database if exists "${dbName}" with (force)`); }
    finally { await admin.close(true); }
    throw error;
  }
}
