// Writes one JSON Schema file per event topic to dist/events/schemas/. Runs after tsc in `build`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eventJsonSchemas } from '../dist/src/events/index.js';

const out = path.resolve(import.meta.dirname, '../dist/events/schemas');
mkdirSync(out, { recursive: true });
for (const [topic, schema] of Object.entries(eventJsonSchemas())) {
  writeFileSync(path.join(out, `${topic}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
}
