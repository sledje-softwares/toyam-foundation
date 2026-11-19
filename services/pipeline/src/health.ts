// Health endpoint for the container platform: GET /healthz (or /health).
// 200 while the loop polls the database successfully; 503 when the last good poll is too old or shutting down.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { WorkerStats } from './worker.ts';

export function healthStatus(stats: WorkerStats, extra: Record<string, unknown>, now: number, maxSilenceMs: number): { code: number; body: Record<string, unknown> } {
  const last = stats.lastPollAt ? Date.parse(stats.lastPollAt) : null;
  const fresh = last !== null && now - last <= maxSilenceMs;
  const ok = !stats.stopping && stats.lastPollOk && (fresh || stats.inflight > 0);
  return {
    code: ok ? 200 : 503,
    body: {
      ok,
      worker_id: stats.workerId,
      started_at: stats.startedAt,
      stages: stats.stages,
      last_poll_at: stats.lastPollAt,
      inflight: stats.inflight,
      claimed: stats.claimed,
      done: stats.done,
      skipped: stats.skipped,
      failed: stats.failed,
      stopping: stats.stopping,
      ...extra,
    },
  };
}

export function startHealthServer(port: number, get: () => { code: number; body: Record<string, unknown> }): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health' || req.url === '/')) {
      const { code, body } = get();
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  server.listen(port, '0.0.0.0');
  return server;
}
