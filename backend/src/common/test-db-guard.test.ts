import { describe, expect, it } from 'vitest';
import { approvedTestDatabases, assertConnectedTo, assertDisposableTestDatabase, databaseNameOf } from '../../test/helpers/db-guard';

/** The safety check in front of the destructive test reset (backend/test/helpers/db-guard.ts). No database is used. */
const url = (db: string, host = '127.0.0.1') => `postgresql://u:p@${host}:5432/${db}`;
const none: NodeJS.ProcessEnv = {};

describe('test database guard', () => {
  it('accepts the approved disposable test database by its exact name', () => {
    expect(assertDisposableTestDatabase(url('aceva_m15_test'), none)).toBe('aceva_m15_test');
  });

  it('refuses aceva_test unless it is explicitly approved', () => {
    expect(() => assertDisposableTestDatabase(url('aceva_test'), none)).toThrow(/not an approved disposable test database/);
    expect(assertDisposableTestDatabase(url('aceva_test'), { ACEVA_APPROVED_TEST_DATABASES: 'aceva_test' })).toBe('aceva_test');
  });

  it('always refuses the protected databases, even when someone approves them', () => {
    for (const db of ['aceva_dev', 'aceva_shadow', 'aceva_realtime_dev']) {
      expect(() => assertDisposableTestDatabase(url(db), { ACEVA_APPROVED_TEST_DATABASES: db })).toThrow(/protected database/);
    }
  });

  it('needs the exact name: "test" in the name, other cases or extra characters are not enough', () => {
    for (const db of ['aceva_m15_test2', 'ACEVA_M15_TEST', 'aceva_m15_test_copy', 'my_test', '']) {
      expect(() => assertDisposableTestDatabase(url(db), none)).toThrow();
    }
  });

  it('refuses a database on another computer and a database chosen in the query string', () => {
    expect(() => assertDisposableTestDatabase(url('aceva_m15_test', 'db.example.com'), none)).toThrow(/this computer/);
    expect(() => assertDisposableTestDatabase(`${url('aceva_m15_test')}?dbname=aceva_dev`, none)).toThrow(/chooses the database/);
    expect(databaseNameOf(url('aceva_m15_test', 'localhost'))).toBe('aceva_m15_test');
  });

  it('lists the built-in and the explicitly approved names', () => {
    expect(approvedTestDatabases({ ACEVA_APPROVED_TEST_DATABASES: ' aceva_test , ,x_test ' })).toEqual(['aceva_m15_test', 'aceva_test', 'x_test']);
  });

  it('checks the database the server actually opened before a reset', async () => {
    const client = (name: string) => ({ query: async () => ({ rows: [{ name }] }) });
    await expect(assertConnectedTo(client('aceva_m15_test'), 'aceva_m15_test')).resolves.toBeUndefined();
    await expect(assertConnectedTo(client('aceva_dev'), 'aceva_m15_test')).rejects.toThrow(/connected to "aceva_dev"/);
  });
});
