import { defineConfig } from "drizzle-kit";

import { getDatabaseMigrationCredentials } from "./src/database-tls";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run Drizzle commands.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: getDatabaseMigrationCredentials(databaseUrl),
  strict: true,
  verbose: true,
});
