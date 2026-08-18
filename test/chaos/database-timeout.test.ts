import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  startAgentService,
  type RunningAgentService,
} from "../../src/index.js";

interface BlackholePostgres {
  port: number;
  server: Server;
  sockets: Set<Socket>;
}

const runningServices: RunningAgentService[] = [];
const databaseClients: DatabaseClient[] = [];
const blackholes: BlackholePostgres[] = [];

afterEach(async () => {
  await Promise.all(
    runningServices.splice(0).map(async (service) => service.shutdown("test")),
  );
  await Promise.all(
    databaseClients.splice(0).map(async (client) => client.close()),
  );
  await Promise.all(
    blackholes.splice(0).map(async ({ server, sockets }) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

async function startBlackholePostgres(): Promise<BlackholePostgres> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // Accept TCP but never answer the PostgreSQL startup packet. This drives
    // pg's real connection timeout without depending on a live database.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const blackhole = { port: address.port, server, sockets };
  blackholes.push(blackhole);
  return blackhole;
}

describe("PostgreSQL timeout recovery", () => {
  it("keeps the service live but not ready and starts no downstream work", async () => {
    const blackhole = await startBlackholePostgres();
    const database = createDatabaseClient({
      connectionString: `postgresql://agent:do-not-expose@127.0.0.1:${blackhole.port}/private`,
      connectionTimeoutMs: 75,
      maxConnections: 1,
      ssl: false,
    });
    databaseClients.push(database);

    const startupFailure = vi.fn<(code: string) => void>();
    const applyMigrations = vi.fn(async () => undefined);
    const startQueue = vi.fn(async () => undefined);
    const checkCodex = vi.fn(async () => ({
      auth: "ok" as const,
      capabilities: "ok" as const,
    }));
    const configureSupermemory = vi.fn(async () => "disabled" as const);
    const startSpectrum = vi.fn(async () => undefined);

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      onStartupFailure: startupFailure,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: () => database.checkReady(),
        applyMigrations,
        startQueue,
        checkCodex,
        configureSupermemory,
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(startupFailure).toHaveBeenCalledOnce();
    expect(startupFailure).toHaveBeenCalledWith("DATABASE_UNAVAILABLE");
    expect(applyMigrations).not.toHaveBeenCalled();
    expect(startQueue).not.toHaveBeenCalled();
    expect(checkCodex).not.toHaveBeenCalled();
    expect(configureSupermemory).not.toHaveBeenCalled();
    expect(startSpectrum).not.toHaveBeenCalled();

    const address = service.health.server.address() as AddressInfo;
    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);

    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as {
      ready: boolean;
      status: "ready" | "not_ready";
    };
    expect(body).toMatchObject({ status: "not_ready", ready: false });
    const internalReadiness = service.readiness.snapshot(
      service.spectrumReadiness.snapshot(),
    );
    expect(internalReadiness).toMatchObject({
      components: {
        database: { code: "DATABASE_UNAVAILABLE", state: "failed" },
        migrations: { state: "unknown" },
        queue: { state: "unknown" },
      },
    });
    expect(internalReadiness.actions).toEqual([
      expect.stringContaining("Restore PostgreSQL connectivity"),
    ]);
    expect(JSON.stringify(body)).not.toContain("do-not-expose");
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });
});
