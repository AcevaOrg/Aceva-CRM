import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Load backend/.env for local development (real servers set real environment variables).
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const env = loadEnv(); // stops here with a clear message if configuration is wrong

  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: env.CORS_ORIGIN, credentials: true });
  configureApp(app);
  // Without this, Ctrl+C, docker stop or a restart ends the process without running the modules' shutdown code: the
  // activity recorder would lose the records it still holds in memory, and the outbox dispatcher would not finish
  // the event it is delivering.
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`Aceva API listening on http://localhost:${env.PORT}/api/v1 (docs: /api/docs)`);
}

void bootstrap();
