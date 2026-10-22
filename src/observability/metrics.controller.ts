import { Controller, Get, Header, Inject } from '@nestjs/common';
import { InfrastructureService } from '../infrastructure.service';
import { telemetry } from './telemetry';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(InfrastructureService) private readonly infrastructure: InfrastructureService) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> { return telemetry.render(() => this.infrastructure.database()); }
}
