import { randomUUID } from 'node:crypto';
import mongoose, { type Connection } from 'mongoose';
import { inject } from 'vitest';
import { Order } from '../../src/orders/domain/order.js';
import { MongoOrderRepository } from '../../src/orders/infra/persistence/mongo-order.repository.js';
import {
  ORDER_MODEL,
  OrderSchema,
  type OrderDocument,
} from '../../src/orders/infra/persistence/order.schema.js';
import { describeOrderRepositoryContract } from '../contracts/order-repository.contract.js';

/** A fresh database per test: the contract never sees leftovers. */
async function openDatabase() {
  const name = `orders_${randomUUID().replaceAll('-', '')}`;
  const uri = inject('mongoUri').replace(/\/(\?|$)/, `/${name}$1`);
  const connection = await mongoose.createConnection(uri).asPromise();
  const model = connection.model<OrderDocument>(ORDER_MODEL, OrderSchema);
  // Builds the indexes before any write: unique constraints must exist first.
  await model.init();
  const close = async () => {
    await connection.dropDatabase();
    await connection.close();
  };
  return { connection, model, close };
}

describeOrderRepositoryContract('MongoDB', async (now) => {
  const { model, close } = await openDatabase();
  return { repository: new MongoOrderRepository(model, now), cleanup: close };
});

describe('MongoOrderRepository: storage details', () => {
  let db: Awaited<ReturnType<typeof openDatabase>>;
  let connection: Connection;

  beforeEach(async () => {
    db = await openDatabase();
    connection = db.connection;
  });
  afterEach(() => db.close());

  it('creates the indexes the queries rely on', async () => {
    const indexes = await connection.collection('orders').indexes();
    const byKey = Object.fromEntries(
      indexes.map((i) => [JSON.stringify(i.key), i]),
    );

    expect(byKey['{"idempotency_keys":1}']).toMatchObject({ unique: true });
    expect(byKey['{"order_id":1}']).toMatchObject({ unique: true });
    expect(byKey['{"status":1,"queue_checked_at":1}']).toBeDefined();
    expect(
      byKey['{"status":1,"failure.retryable":1,"created_at":-1}'],
    ).toBeDefined();
  });

  it('stores snake_case fields, matching the API payload, with timestamps', async () => {
    const repository = new MongoOrderRepository(db.model);
    const order = await repository.insert(
      Order.receive({
        orderId: 'ext-1',
        idempotencyKey: 'key-1',
        customer: { email: 'user@example.com', name: 'Ana' },
        items: [{ sku: 'ABC123', qty: 2, unitPrice: 59.9 }],
        currency: 'USD',
      }),
    );

    const raw = await connection
      .collection('orders')
      .findOne({ _id: new mongoose.Types.ObjectId(order.id) });

    expect(raw).toMatchObject({
      order_id: 'ext-1',
      idempotency_keys: ['key-1'],
      items: [{ sku: 'ABC123', qty: 2, unit_price: 59.9 }],
      status: 'RECEIVED',
      reprocess_count: 0,
      queue_checked_at: expect.any(Date),
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
  });
});
