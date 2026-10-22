import 'reflect-metadata';
import { ConsoleLogger, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthController } from './health.controller';
import { InfrastructureService } from './infrastructure.service';
import { FinancialService } from './application/financial-service';
import { FinancialController } from './http/financial.controller';
import { ErrorFilter } from './http/error.filter';
import { DevelopmentProviderIdentity, ProviderIdentityPort } from './http/provider-identity';
import { MetricsController } from './observability/metrics.controller';

@Module({
  controllers: [HealthController, FinancialController, MetricsController],
  providers: [InfrastructureService,
    { provide: FinancialService, inject: [InfrastructureService],
      useFactory: (infrastructure: InfrastructureService) => new FinancialService(() => infrastructure.database()) },
    { provide: ProviderIdentityPort, useClass: DevelopmentProviderIdentity },
  ],
})
class AppModule {}

export async function createApplication(quiet = false): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: quiet ? false : new ConsoleLogger({ json: true }) });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}
