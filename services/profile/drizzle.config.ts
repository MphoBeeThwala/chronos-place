import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/db/schema.ts. No database connection is needed to generate.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  schemaFilter: ['profile'],
  // Kept outside the profile schema: the first migration creates that schema.
  migrations: { schema: 'drizzle', table: 'profile_migrations' },
});
