import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { testDatabaseUrl } from './env';

export interface TestApp {
  app: INestApplication;
  /** supertest request made "as" an employee (development identity header). */
  as: (empId: string | null) => ReturnType<typeof asFactory>;
  close: () => Promise<void>;
}

function asFactory(app: INestApplication, empId: string | null) {
  const server = app.getHttpServer();
  const add = (r: request.Test) => (empId ? r.set('X-Dev-Emp-Id', empId) : r);
  return {
    get: (url: string) => add(request(server).get(url)),
    post: (url: string) => add(request(server).post(url)),
    patch: (url: string) => add(request(server).patch(url)),
    delete: (url: string) => add(request(server).delete(url)),
  };
}

/** Starts the real application (all modules) against the aceva_test database. */
export async function createTestApp(options: { devIdentity?: boolean; extraControllers?: Type[] } = {}): Promise<TestApp> {
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.NODE_ENV = 'test';
  process.env.DEV_IDENTITY_ENABLED = options.devIdentity === false ? 'false' : 'true';

  const builder = Test.createTestingModule({ imports: [AppModule], controllers: options.extraControllers ?? [] });
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, as: (empId) => asFactory(app, empId), close: () => app.close() };
}
