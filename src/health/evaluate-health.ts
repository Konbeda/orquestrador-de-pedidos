import type { CircuitState } from '../shared/resilience/circuit-breaker.js';

export interface HealthProbes {
  mongo: boolean;
  redis: boolean;
  frankfurter: {
    circuit: CircuitState;
    currenciesSource: 'provider' | 'fallback';
  };
}

type CheckStatus = 'up' | 'degraded' | 'down';

export interface HealthReport {
  httpStatus: 200 | 503;
  body: {
    status: 'ok' | 'degraded' | 'down';
    checks: {
      mongo: { status: CheckStatus };
      redis: { status: CheckStatus };
      frankfurter: {
        status: CheckStatus;
        circuit: CircuitState;
        currencies_source: 'provider' | 'fallback';
        hint?: string;
      };
    };
  };
}

/**
 * Three states, not two: only Mongo is critical (no Mongo, no orders).
 * Redis or Frankfurter out means the app still accepts orders and only the
 * enrichment waits, so the instance must stay in the load balancer (200).
 */
export function evaluateHealth(probes: HealthProbes): HealthReport {
  const { circuit, currenciesSource } = probes.frankfurter;
  const frankfurterStatus: CheckStatus =
    circuit === 'open'
      ? 'down'
      : circuit === 'half_open' || currenciesSource === 'fallback'
        ? 'degraded'
        : 'up';

  const checks: HealthReport['body']['checks'] = {
    mongo: { status: probes.mongo ? 'up' : 'down' },
    redis: { status: probes.redis ? 'up' : 'down' },
    frankfurter: {
      status: frankfurterStatus,
      circuit,
      currencies_source: currenciesSource,
      ...(currenciesSource === 'fallback'
        ? {
            hint: 'Supported currencies come from SUPPORTED_CURRENCIES_FALLBACK: Frankfurter /currencies did not answer since boot (down, or a wrong FRANKFURTER_BASE_URL)',
          }
        : {}),
    },
  };

  if (!probes.mongo)
    return { httpStatus: 503, body: { status: 'down', checks } };
  const allUp = Object.values(checks).every((check) => check.status === 'up');
  return {
    httpStatus: 200,
    body: { status: allUp ? 'ok' : 'degraded', checks },
  };
}
