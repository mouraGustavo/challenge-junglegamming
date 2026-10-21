import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { InfrastructureService } from './infrastructure.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(InfrastructureService) private readonly infrastructure: InfrastructureService) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; checks: { postgres: boolean; sqs: boolean } }> {
    const checks = await this.infrastructure.readiness();
    if (!checks.postgres || !checks.sqs) {
      throw new ServiceUnavailableException({ status: 'not_ready', checks });
    }
    return { status: 'ok', checks };
  }
}
