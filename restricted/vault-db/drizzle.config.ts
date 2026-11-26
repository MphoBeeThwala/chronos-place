import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/schema.ts. No database connection is needed to generate.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['vault'],
  // Kept outside the vault schema: the first migration creates that schema.
  migrations: { schema: 'drizzle', table: 'vault_migrations' },
});
