import { describeOrderRepositoryContract } from '../contracts/order-repository.contract.js';
import { InMemoryOrderRepository } from './in-memory-order.repository.js';

// The fake every use case test relies on must honor the same contract as Mongo.
describeOrderRepositoryContract('in-memory fake', async (now) => ({
  repository: new InMemoryOrderRepository(now),
}));
