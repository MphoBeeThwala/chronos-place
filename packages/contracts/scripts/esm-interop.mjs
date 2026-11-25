// ts-proto writes `import { wrappers } from "protobufjs"`, but protobufjs is CommonJS and Node
// cannot see that named export from an ES module, so services fail at startup under plain node
// (Vitest hides it). Rewrite it to the default import Node accepts. Runs after `buf generate`.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAMED = 'import { wrappers } from "protobufjs";';
const DEFAULT = 'import protobufjs from "protobufjs";\nconst { wrappers } = protobufjs;';

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts')) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(NAMED)) writeFileSync(path, text.replace(NAMED, DEFAULT));
    }
  }
}
walk(new URL('../gen', import.meta.url).pathname);
