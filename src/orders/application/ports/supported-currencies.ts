/** Currencies the exchange provider can convert (cached list, with a fallback when it is down). */
export abstract class SupportedCurrencies {
  abstract isSupported(currency: string): Promise<boolean>;
}
