import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createTestApp } from '../helpers/test-app.js';

describe('App boot (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('connects to Mongo with the validated configuration', () => {
    const connection = app.get<Connection>(getConnectionToken());

    expect(connection.readyState).toBe(1);
  });
});
