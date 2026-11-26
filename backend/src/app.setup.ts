import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { requestContextMiddleware } from './common/request-context';
import { ENV } from './config/config.module';
import type { Env } from './config/env';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RealtimeAdapter } from './comms/realtime/realtime.adapter';

/** Settings shared by the real server (main.ts) and the automated tests. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // Behind a reverse proxy the real client address (used for login rate limiting) is in X-Forwarded-For.
  express.set('trust proxy', env.TRUST_PROXY);
  // First: every request gets an id that the audit log and the activity recorder share (Module 4 "Changes").
  app.use(requestContextMiddleware);
  app.use(cookieParser());
  // Module 14, part 2: Socket.IO on the same server (/socket.io), WebSocket only, Origin checked before the upgrade.
  app.useWebSocketAdapter(new RealtimeAdapter(app));
  app.setGlobalPrefix('api/v1', { exclude: [] });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Aceva Digital System API')
      .setDescription('M1 hierarchy and access, M2 login and sessions, M3 employee profiles, M4 activity tracking.')
      .setVersion('0.1.0')
      .addCookieAuth('aceva_session')
      .build(),
  );
  // Docs live at /api/docs (outside the /api/v1 prefix).
  SwaggerModule.setup('api/docs', app, document);
}
