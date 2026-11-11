import { SupportedCurrencies } from '../../src/orders/application/ports/supported-currencies.js';

export class FakeSupportedCurrencies extends SupportedCurrencies {
  constructor(private readonly codes = new Set(['USD', 'EUR', 'BRL'])) {
    super();
  }

  async isSupported(currency: string): Promise<boolean> {
    return this.codes.has(currency.toUpperCase());
  }
}
