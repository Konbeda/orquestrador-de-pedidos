import http from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import {
  ProviderRejectedError,
  ProviderUnavailableError,
} from '../../src/orders/application/ports/exchange-rate.provider.js';
import { FrankfurterClient } from '../../src/orders/infra/exchange/frankfurter.client.js';

// Response bodies below are copies of what api.frankfurter.dev/v1 answered (2026-11-10).
const BASE = 'https://frankfurter.test/v1';

describe('FrankfurterClient (HTTP mocked with nock)', () => {
  const client = () => new FrankfurterClient({ baseUrl: BASE, timeoutMs: 200 });
  const api = () => nock('https://frankfurter.test').get(/\/v1\/.*/);

  beforeAll(() => nock.disableNetConnect());
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });
  afterAll(() => nock.enableNetConnect());

  describe('getRate', () => {
    it('asks for the pair and returns the rate with its date', async () => {
      nock('https://frankfurter.test')
        .get('/v1/latest')
        .query({ base: 'USD', symbols: 'BRL' })
        .reply(200, {
          amount: 1.0,
          base: 'USD',
          date: '2026-11-10',
          rates: { BRL: 5.5517 },
        });

      await expect(client().getRate('USD', 'BRL')).resolves.toEqual({
        rate: 5.5517,
        date: '2026-11-10',
      });
    });

    it('works with a base URL that ends in a slash', async () => {
      nock('https://frankfurter.test')
        .get('/v1/latest')
        .query(true)
        .reply(200, {
          amount: 1,
          base: 'USD',
          date: '2026-11-10',
          rates: { BRL: 5 },
        });

      const slashed = new FrankfurterClient({
        baseUrl: `${BASE}/`,
        timeoutMs: 200,
      });

      await expect(slashed.getRate('USD', 'BRL')).resolves.toMatchObject({
        rate: 5,
      });
    });

    it.each([
      [404, { message: 'not found' }, 'unknown or unsupported currency'],
      [422, { message: 'bad currency pair' }, 'same currency on both sides'],
      [400, { message: 'bad request' }, 'malformed request'],
    ])(
      'a %i (%s) is permanent: ProviderRejectedError',
      async (status, body) => {
        api().query(true).reply(status, body);

        await expect(client().getRate('ARS', 'BRL')).rejects.toThrow(
          ProviderRejectedError,
        );
      },
    );

    it.each([
      [429, 'rate limited'],
      [408, 'request timeout'],
      [500, 'server error'],
      [502, 'bad gateway'],
      [503, 'unavailable'],
    ])('a %i (%s) is temporary: ProviderUnavailableError', async (status) => {
      api().query(true).reply(status, { message: 'nope' });

      await expect(client().getRate('USD', 'BRL')).rejects.toThrow(
        ProviderUnavailableError,
      );
    });

    it('a response slower than the timeout is temporary, and does not wait for it', async () => {
      // A real local server that accepts and never answers. (nock's delay() plus an
      // aborted native fetch trips an undici assertion inside the interceptor.)
      const silent = http.createServer(() => undefined);
      await new Promise<void>((resolve) =>
        silent.listen(0, '127.0.0.1', resolve),
      );
      const { port } = silent.address() as AddressInfo;
      nock.enableNetConnect('127.0.0.1');
      try {
        const started = Date.now();
        const slow = new FrankfurterClient({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          timeoutMs: 200,
        });

        await expect(slow.getRate('USD', 'BRL')).rejects.toThrow(
          ProviderUnavailableError,
        );
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        nock.disableNetConnect();
        silent.closeAllConnections();
        await new Promise((resolve) => silent.close(resolve));
      }
    });

    it('a network failure is temporary', async () => {
      api()
        .query(true)
        .replyWithError({ code: 'ECONNRESET', message: 'socket hang up' });

      await expect(client().getRate('USD', 'BRL')).rejects.toThrow(
        ProviderUnavailableError,
      );
    });

    it.each([
      ['not JSON', 'Service temporarily unavailable'],
      [
        'JSON without the asked rate',
        { amount: 1, base: 'USD', date: '2026-11-10', rates: {} },
      ],
      [
        'JSON with a non numeric rate',
        { amount: 1, base: 'USD', date: '2026-11-10', rates: { BRL: 'x' } },
      ],
    ])(
      'a 200 with an unexpected body (%s) is temporary',
      async (_case, body) => {
        api().query(true).reply(200, body);

        await expect(client().getRate('USD', 'BRL')).rejects.toThrow(
          ProviderUnavailableError,
        );
      },
    );

    it('is always available: the raw client has no circuit of its own', () => {
      expect(client().isAvailable()).toBe(true);
    });
  });

  describe('listCurrencies', () => {
    it('returns the supported ISO codes', async () => {
      nock('https://frankfurter.test')
        .get('/v1/currencies')
        .reply(200, {
          BRL: 'Brazilian Real',
          EUR: 'Euro',
          USD: 'United States Dollar',
        });

      await expect(client().listCurrencies()).resolves.toEqual([
        'BRL',
        'EUR',
        'USD',
      ]);
    });

    it('a failure is temporary (the caller falls back to its configured list)', async () => {
      nock('https://frankfurter.test').get('/v1/currencies').reply(503);

      await expect(client().listCurrencies()).rejects.toThrow(
        ProviderUnavailableError,
      );
    });
  });
});
