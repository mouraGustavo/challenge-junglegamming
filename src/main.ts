import 'reflect-metadata';
import { config } from './config';
import { createApplication } from './app';

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  app.enableShutdownHooks();
  await app.listen(config.port, process.env.HOST ?? '127.0.0.1');
}

void bootstrap().catch(() => {
  console.error(JSON.stringify({ level: 'error', code: 'BOOTSTRAP_FAILED' }));
  process.exitCode = 1;
});
