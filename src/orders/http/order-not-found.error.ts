export class OrderNotFoundError extends Error {
  override name = 'OrderNotFoundError';
  constructor(readonly id: string) {
    super(`Order ${id} not found`);
  }
}
