import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Settings shared by the real server (main.ts) and the automated tests. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1', { exclude: [] });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Aceva Digital System API')
      .setDescription('Cycle 1 backend: M1 hierarchy and access, M2 login and sessions, M3 employee profiles.')
      .setVersion('0.1.0')
      .build(),
  );
  // Docs live at /api/docs (outside the /api/v1 prefix).
  SwaggerModule.setup('api/docs', app, document);
}
