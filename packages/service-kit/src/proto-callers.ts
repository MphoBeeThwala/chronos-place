import { readFileSync } from 'node:fs';

/**
 * The callers each RPC's comment names (`Caller: gateway.`, `Callers: gateway, discovery (M3).`,
 * `Caller: none ...`), read from a .proto file. A comment heading a group of RPCs applies to every
 * RPC after it until the next `Caller` comment. Used by tests to keep allow-lists and contracts in
 * step (M2.5).
 */
export function callersFromProto(protoPath: string, service: string): Map<string, string[]> {
  const text = readFileSync(protoPath, 'utf8');
  const start = text.indexOf(`service ${service} {`);
  if (start === -1) throw new Error('service not found in proto');
  const body = text.slice(start, text.indexOf('\n}', start));
  const result = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of body.split('\n')) {
    // A note in brackets may contain dots: `discovery (M3.2).`
    const named = /Callers?: ((?:[^.(]|\([^)]*\))*)/.exec(line);
    if (named?.[1] !== undefined) {
      const list = named[1].replace(/\([^)]*\)/g, '').trim();
      current =
        list === 'none' || list.startsWith('none ')
          ? []
          : list
              .split(',')
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
    }
    const rpc = /^\s*rpc (\w+)\(/.exec(line);
    if (rpc?.[1] !== undefined) {
      if (current === undefined) throw new Error('rpc without a Caller comment');
      result.set(rpc[1], current);
    }
  }
  return result;
}

/** Caller names per method of an allow-list, for comparing with `callersFromProto`. */
export function callersOf(
  methods: Readonly<Record<string, readonly (string | { caller: string })[]>>,
): Map<string, string[]> {
  return new Map(
    Object.entries(methods).map(([method, rules]) => [
      method,
      [...new Set(rules.map((r) => (typeof r === 'string' ? r : r.caller)))],
    ]),
  );
}
