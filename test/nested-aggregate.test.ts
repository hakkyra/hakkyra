import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startServer, stopServer, closePool, waitForDb,
  graphqlRequest, tokens,
  ALICE_ID, BOB_ID, CHARLIE_ID,
  TEST_DB_URL, ADMIN_SECRET,
} from './setup.js';

type AnyRow = Record<string, unknown>;

// ─── Server lifecycle ────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env['DATABASE_URL'] = TEST_DB_URL;
  process.env['HAKKYRA_ADMIN_SECRET'] = ADMIN_SECRET;
  await waitForDb();
  await startServer();
}, 30_000);

afterAll(async () => {
  await stopServer();
  await closePool();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Nested aggregate fields on object types', () => {

  describe('clientByPk with invoicesAggregate', () => {
    it('returns aggregate count for Alice (2 invoices)', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            id
            username
            invoicesAggregate {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      expect(client).toBeDefined();
      expect(client.id).toBe(ALICE_ID);
      const invAgg = client.invoicesAggregate as AnyRow;
      expect(invAgg).toBeDefined();
      const aggregate = invAgg.aggregate as AnyRow;
      expect(aggregate).toBeDefined();
      // Alice has at least 2 invoices from seed data (other tests may insert more)
      expect(aggregate.count).toBeGreaterThanOrEqual(2);
    });

    it('returns aggregate count for Bob (1 invoice)', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${BOB_ID}") {
            id
            invoicesAggregate {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const aggregate = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      expect(aggregate.count).toBe(1);
    });

    it('returns aggregate count 0 for Charlie (no invoices)', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${CHARLIE_ID}") {
            id
            invoicesAggregate {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const aggregate = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      expect(aggregate.count).toBe(0);
    });
  });

  describe('select list with nested aggregate', () => {
    it('returns invoicesAggregate on each client in a list query', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clients(orderBy: [{ id: ASC }]) {
            id
            invoicesAggregate {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const clients = (body.data as { clients: AnyRow[] }).clients;
      expect(clients.length).toBeGreaterThan(0);

      // Each client should have invoicesAggregate with a count
      for (const client of clients) {
        const invAgg = client.invoicesAggregate as AnyRow;
        expect(invAgg).toBeDefined();
        expect(invAgg.aggregate).toBeDefined();
        expect((invAgg.aggregate as AnyRow).count).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('with where filter on aggregate', () => {
    it('filters invoices by amount in the aggregate', async () => {
      const token = await tokens.backoffice();

      // First, get total invoice count without filter
      const { body: totalBody } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            invoicesAggregate {
              aggregate { count }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      const totalCount = ((totalBody.data as any).clientByPk.invoicesAggregate.aggregate as AnyRow).count as number;

      // Now query with filter — should be less than total
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            id
            invoicesAggregate(where: { amount: { _gt: "75" } }) {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const aggregate = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      // Filtered count should be at least 1 (the 100.00 invoice) and less than total
      expect(aggregate.count).toBeGreaterThanOrEqual(1);
      expect(aggregate.count).toBeLessThan(totalCount);
    });

    it('returns count 0 when where filter matches nothing', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            id
            invoicesAggregate(where: { amount: { _gt: "99999" } }) {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const aggregate = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      expect(aggregate.count).toBe(0);
    });
  });

  describe('admin access', () => {
    it('works with admin secret', async () => {
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            id
            invoicesAggregate {
              aggregate {
                count
              }
            }
          }
        }`,
        undefined,
        { 'x-hasura-admin-secret': ADMIN_SECRET },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const aggregate = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      expect(aggregate.count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('multiple aggregate relationships on same parent', () => {
    it('can query both invoicesAggregate and accountsAggregate', async () => {
      const token = await tokens.backoffice();
      const { status, body } = await graphqlRequest(
        `query {
          clientByPk(id: "${ALICE_ID}") {
            id
            invoicesAggregate {
              aggregate { count }
            }
            accountsAggregate {
              aggregate { count }
            }
          }
        }`,
        undefined,
        { authorization: `Bearer ${token}` },
      );
      expect(status).toBe(200);
      expect(body.errors).toBeUndefined();
      const client = (body.data as { clientByPk: AnyRow }).clientByPk;
      const invAgg = (client.invoicesAggregate as AnyRow).aggregate as AnyRow;
      const accAgg = (client.accountsAggregate as AnyRow).aggregate as AnyRow;
      // Alice has at least 2 invoices (other tests may insert more)
      expect(invAgg.count).toBeGreaterThanOrEqual(2);
      expect(accAgg.count).toBeGreaterThanOrEqual(1);
    });
  });
});
