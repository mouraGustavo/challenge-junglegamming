import { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../config';
import { entities } from './records';

export function createOrm(connect = true, database = config.database): Promise<MikroORM> {
  return MikroORM.init({ ...database, entities, connect,
    // Bursts (ex.: 50 requisições) aguardam uma conexão, sem ampliar o pool.
    // O timeout do lock financeiro continua separado, em 3s por transação.
    pool: { min: 0, max: 10, acquireTimeoutMillis: 15000 }, debug: false });
}
