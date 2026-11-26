import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callersFromProto, callersOf } from '../src/index.js';

const proto = `syntax = "proto3";
service S {
  // One. Caller: gateway.
  rpc A(X) returns (X);
  // Two. Callers: gateway, discovery (M3).
  rpc B(X) returns (X);

  // Group heading (TASKS M1). Caller: identity.
  // Detail without callers.
  rpc C(X) returns (X);
  rpc D(X) returns (X);
  // Nobody yet. Caller: none until a decision.
  rpc E(X) returns (X);
  // Callers: gateway, moderation (purpose MODERATION only).
  rpc F(X) returns (X);
  // Callers: profile, discovery (M3.2).
  rpc G(X) returns (X);
}`;

describe('callersFromProto', () => {
  it('reads each RPC callers, including group headings and "none"', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'proto-')), 's.proto');
    writeFileSync(file, proto);
    expect(Object.fromEntries(callersFromProto(file, 'S'))).toEqual({
      A: ['gateway'],
      B: ['gateway', 'discovery'],
      C: ['identity'],
      D: ['identity'],
      E: [],
      F: ['gateway', 'moderation'],
      G: ['profile', 'discovery'],
    });
  });

  it('collects caller names of an allow-list', () => {
    expect(
      Object.fromEntries(callersOf({ A: ['gateway', { caller: 'gateway' }, { caller: 'mod' }] })),
    ).toEqual({ A: ['gateway', 'mod'] });
  });
});
