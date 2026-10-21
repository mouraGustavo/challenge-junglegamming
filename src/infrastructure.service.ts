import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config';
import { createOrm } from './persistence/orm';

@Injectable()
export class InfrastructureService implements OnModuleDestroy {
  private readonly sqs = new SQSClient(config.sqs);
  private ormPromise?: Promise<MikroORM>;

  database(): Promise<MikroORM> {
    if (!this.ormPromise) {
      this.ormPromise = createOrm(false).catch((error: unknown) => {
        this.ormPromise = undefined;
        throw error;
      });
    }
    return this.ormPromise;
  }

  async readiness(): Promise<{ postgres: boolean; sqs: boolean }> {
    const results = await Promise.allSettled([
      this.database().then((orm) => orm.em.getConnection().execute('select 1')),
      this.sqs.send(new ListQueuesCommand({ MaxResults: 1 }), {
        abortSignal: AbortSignal.timeout(3000),
      }),
    ]);
    return {
      postgres: results[0].status === 'fulfilled',
      sqs: results[1].status === 'fulfilled',
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.sqs.destroy();
    const orm = await this.ormPromise?.catch(() => undefined);
    await orm?.close(true);
  }
}
