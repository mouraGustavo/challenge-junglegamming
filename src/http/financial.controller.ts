import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { FinancialService, type ProcessingContext } from '../application/financial-service';
import { object, text } from '../application/contracts';
import { ProviderIdentityPort } from './provider-identity';

@Controller()
export class FinancialController {
  constructor(@Inject(FinancialService) private readonly financial: FinancialService,
    @Inject(ProviderIdentityPort) private readonly identity: ProviderIdentityPort) {}

  @Post('wallets')
  createWallet(@Body() body: unknown, @Headers('x-correlation-id') correlation?: string) {
    return this.financial.createWallet(body, this.context(correlation));
  }
  @Get('wallets/:walletId')
  wallet(@Param('walletId') id: string) { return this.financial.getWallet(id); }

  @Get('wallets/:walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor?: unknown, @Query('limit') limit?: unknown) {
    return this.financial.ledger(id, cursor, limit);
  }
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') id: string) { return this.financial.reconcile(id); }
  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId') id: string) { return this.financial.getTransaction(id); }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  providerTransaction(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    this.identity.assertProvider(text(provider));
    return this.financial.getProviderTransaction(provider, external);
  }
  @Post('wagering/transactions')
  async process(@Body() body: unknown, @Headers('idempotency-key') key: unknown,
    @Headers('x-correlation-id') correlation: string | undefined,
    @Res({ passthrough: true }) response: { status(code: number): unknown }) {
    this.identity.assertProvider(text(object(body).providerId));
    const result = await this.financial.process(body, key, this.context(correlation));
    const status = result.status === 'PROCESSED' ? 200
      : result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 500 : 202;
    response.status(status);
    return result;
  }
  private context(correlation?: string): ProcessingContext {
    return correlation === undefined ? {} : { correlationId: text(correlation, 200) };
  }
}
