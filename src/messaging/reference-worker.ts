import type { MikroORM } from '@mikro-orm/postgresql';
import type { FinancialService } from '../application/financial-service';
import { WagerRecord } from '../persistence/records';
import { telemetry } from '../observability/telemetry';

export class ReferenceWorker {
  constructor(private readonly database: () => Promise<MikroORM>, private readonly financial: FinancialService,
    private readonly maxAttempts = 10) {}

  async runOnce(now = new Date()): Promise<number> {
    const orm = await this.database();
    const records = await orm.em.fork().find(WagerRecord,
      { status: 'PENDING_REFERENCE', nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'asc', id: 'asc' }, limit: 10 });
    let attempted = 0;
    // A seleção não segura lock. O caso de uso verifica status e agenda novamente
    // após adquirir wallet → wager. Dois workers não aplicam a mesma pendência.
    for (const record of records) {
      if (await this.financial.retryReference(record.id, now, this.maxAttempts)) {
        attempted += 1;
        telemetry.retry('reference');
      }
    }
    return attempted;
  }
}
