import { resolve } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loadDatabaseMigrationEnvironment } from "../config/env.js";
import { createDatabaseClient, type DatabaseClient } from "./client.js";

export async function runDatabaseMigrations(
  client: DatabaseClient,
  migrationsFolder = resolve("src/db/migrations"),
): Promise<void> {
  await migrate(client.database, { migrationsFolder });
}

async function main(): Promise<void> {
  const environment = loadDatabaseMigrationEnvironment();
  const client = createDatabaseClient({ connectionString: environment.DATABASE_URL });

  try {
    await runDatabaseMigrations(client);
  } catch (error) {
    throw new Error(
      "Database migration failed. Verify DATABASE_URL, PostgreSQL >=13, and migration permissions before restarting.",
      { cause: error },
    );
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
