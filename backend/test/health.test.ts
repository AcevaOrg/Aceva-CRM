import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { healthResponseSchema } from '@aceva/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { testDatabaseUrl } from './helpers/env';

describe('GET /api/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns 200 and reports the real database as up', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(healthResponseSchema.parse(response.body)).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('serves Swagger documentation at /api/docs', async () => {
    const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(response.body.paths['/api/v1/health']).toBeDefined();
  });

  it('reports "degraded" (not a crash) when the database stops answering', async () => {
    const prisma = app.get(PrismaService);
    const original = prisma.$queryRaw;
    (prisma as unknown as { $queryRaw: () => Promise<never> }).$queryRaw = () => Promise.reject(new Error('down'));
    try {
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      expect(response.body).toMatchObject({ status: 'degraded', database: 'down' });
    } finally {
      (prisma as unknown as { $queryRaw: unknown }).$queryRaw = original;
    }
  });
});
