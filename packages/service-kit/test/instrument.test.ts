import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort, MARKER } from './helpers.js';

const dist = path.resolve(import.meta.dirname, '../dist');

describe('--import @chronos/service-kit/instrument', () => {
  let collector: Server | undefined;
  afterEach(() => {
    collector?.close();
  });

  it('traces plain ES-module HTTP traffic and scrubs it before export', async () => {
    const bodies: string[] = [];
    const port = await freePort();
    collector = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (c: Buffer) => chunks.push(c));
      request.on('end', () => {
        if (request.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('latin1'));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    }).listen(port, '127.0.0.1');

    // A tiny ES-module app: an HTTP server, one request to it, then a clean exit that flushes spans.
    const app = `
      import http from 'node:http';
      import { trace } from '@opentelemetry/api';
      const server = http.createServer((req, res) => res.end('ok')).listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get('http://127.0.0.1:' + port + '/feed?condition=${MARKER}', (res) => {
          res.resume();
          res.on('end', async () => {
            server.close();
            await globalThis[Symbol.for('chronos.service-kit.telemetry')].shutdown();
          });
        });
      });
    `;
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', path.join(dist, 'instrument.js'), '--input-type=module', '-e', app],
        {
          cwd: path.resolve(import.meta.dirname, '..'),
          env: {
            PATH: process.env['PATH'] ?? '',
            SERVICE_NAME: 'instrument-test',
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${String(port)}`,
          },
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('close', (status) => {
        resolve({ status, stderr });
      });
    });
    expect(result.status, result.stderr).toBe(0);
    const sent = bodies.join('\n');
    expect(sent).toContain('instrument-test');
    expect(sent).toMatch(/"name":"GET"/);
    expect(sent).not.toContain(MARKER);
  });
});
