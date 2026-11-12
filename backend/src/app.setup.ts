import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ENV } from './config/config.module';
import type { Env } from './config/env';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Settings shared by the real server (main.ts) and the automated tests. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // Behind a reverse proxy the real client address (used for login rate limiting) is in X-Forwarded-For.
  express.set('trust proxy', env.TRUST_PROXY);
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: [] });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Aceva Digital System API')
      .setDescription('Cycle 1 backend: M1 hierarchy and access, M2 login and sessions, M3 employee profiles.')
      .setVersion('0.1.0')
      .addCookieAuth('aceva_session')
      .build(),
  );
  // Docs live at /api/docs (outside the /api/v1 prefix).
  SwaggerModule.setup('api/docs', app, document);
}
