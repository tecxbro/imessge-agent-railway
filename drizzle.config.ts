import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./src/db/schema-fragments/*.ts"],
  out: "./src/db/migrations",
  strict: true,
  verbose: true,
});
