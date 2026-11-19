// Polling loop (6.1, D38): claim jobs of the enabled stages up to the concurrency limit, run each stage
// handler, complete the job. Idle polls back off; database errors back off too. On shutdown no new jobs are
// claimed, running ones get a grace period and are then aborted and handed back (failed -> re-queued with
// the database's back-off). Jobs left `running` by a crashed worker are handed back at start and when
// older than `staleMinutes`.
import type { PipelineDb } from './db.ts';
import type { Logger } from './log.ts';
import { errorText } from './log.ts';
import type { Job, Stage, StageOutcome } from './types.ts';

export type Handler = (job: Job, signal: AbortSignal) => Promise<StageOutcome>;

export interface WorkerOptions {
  workerId: string;
  stages: Stage[];
  concurrency: number;
  pollMs: number;                      // first idle wait
  maxIdleMs: number;                   // idle back-off cap
  staleMinutes: number;
  shutdownGraceMs: number;
  /** test hooks */
  sleep?:(ms: number, wake: Promise<void>) => Promise<void>;
  now?: () => number;
}

export interface WorkerStats {
  workerId: string;
  startedAt: string;
  stages: Stage[];
  inflight: number;
  claimed: number;
  done: number;
  skipped: number;
  failed: number;
  lastPollAt: string | null;
  lastPollOk: boolean;
  stopping: boolean;
}

export class Worker {
  db: PipelineDb;
  handlers: Partial<Record<Stage, Handler>>;
  log: Logger;
  opts: WorkerOptions;
  stats: WorkerStats;
  running: Map<number, { job: Job; ctrl: AbortController; done: Promise<void> }>;
  stopping: boolean;
  loopDone: Promise<void> | null;
  wakeResolve: (() => void) | null;
  wake: Promise<void>;
  lastStaleCheck: number;

  constructor(db: PipelineDb, handlers: Partial<Record<Stage, Handler>>, log: Logger, opts: WorkerOptions) {
    this.db = db;
    this.handlers = handlers;
    this.log = log;
    this.opts = opts;
    const now = opts.now ?? Date.now;
    this.stats = {
      workerId: opts.workerId, startedAt: new Date(now()).toISOString(), stages: opts.stages.filter((s) => handlers[s]),
      inflight: 0, claimed: 0, done: 0, skipped: 0, failed: 0, lastPollAt: null, lastPollOk: false, stopping: false,
    };
    this.running = new Map();
    this.stopping = false;
    this.loopDone = null;
    this.wakeResolve = null;
    this.wake = this.newWake();
    this.lastStaleCheck = 0;
  }

  newWake(): Promise<void> {
    return new Promise<void>((r) => { this.wakeResolve = r; });
  }

  poke(): void {
    const r = this.wakeResolve;
    this.wake = this.newWake();
    r?.();
  }

  now(): number {
    return (this.opts.now ?? Date.now)();
  }

  sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms, this.wake);
    return new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      void this.wake.then(() => { clearTimeout(t); res(); });
    });
  }

  start(): Promise<void> {
    this.loopDone ??= this.loop();
    return this.loopDone;
  }

  /** Hand back jobs a previous run of this worker (same id) or a dead worker left running. */
  async recoverStale(atStart: boolean): Promise<number> {
    const rows = await this.db.listRunningJobs();
    const cutoff = this.now() - this.opts.staleMinutes * 60_000;
    let n = 0;
    for (const r of rows) {
      if (this.running.has(r.id)) continue;
      const mine = atStart && r.locked_by === this.opts.workerId;
      const old = r.locked_at !== null && Date.parse(r.locked_at) < cutoff;
      if (!mine && !old) continue;
      try {
        await this.db.completeJob(r.id, 'failed', mine ? 'worker restarted while the job was running' : 'stale: no worker finished the job');
        n++;
      } catch (err) {
        this.log.log('warn', 'stale_requeue_failed', { job_id: r.id, error: errorText(err) });
      }
    }
    if (n) this.log.log('warn', 'stale_jobs_requeued', { count: n });
    return n;
  }

  async loop(): Promise<void> {
    const stages = this.stats.stages;
    if (stages.length === 0) {
      this.log.log('error', 'no_stages_enabled', {});
      return;
    }
    try {
      await this.recoverStale(true);
    } catch (err) {
      this.log.log('warn', 'stale_check_failed', { error: errorText(err) });
    }
    this.lastStaleCheck = this.now();
    let idle = this.opts.pollMs;
    while (!this.stopping) {
      if (this.now() - this.lastStaleCheck > 5 * 60_000) {
        this.lastStaleCheck = this.now();
        await this.recoverStale(false).catch((err) => this.log.log('warn', 'stale_check_failed', { error: errorText(err) }));
      }
      const free = this.opts.concurrency - this.running.size;
      if (free <= 0) {
        await this.sleep(this.opts.maxIdleMs);         // woken as soon as a job finishes
        continue;
      }
      let jobs: Job[];
      try {
        jobs = await this.db.claimJobs(stages, free, this.opts.workerId);
        this.stats.lastPollAt = new Date(this.now()).toISOString();
        this.stats.lastPollOk = true;
      } catch (err) {
        this.stats.lastPollOk = false;
        this.log.log('error', 'claim_failed', { error: errorText(err), retry_in_ms: idle });
        await this.sleep(idle);
        idle = Math.min(idle * 2, this.opts.maxIdleMs);
        continue;
      }
      if (jobs.length === 0) {
        await this.sleep(idle);
        idle = Math.min(idle * 2, this.opts.maxIdleMs);
        continue;
      }
      idle = this.opts.pollMs;
      this.stats.claimed += jobs.length;
      for (const job of jobs) this.launch(job);
    }
  }

  launch(job: Job): void {
    const ctrl = new AbortController();
    const done = this.run(job, ctrl.signal).finally(() => {
      this.running.delete(job.id);
      this.stats.inflight = this.running.size;
      this.poke();
    });
    this.running.set(job.id, { job, ctrl, done });
    this.stats.inflight = this.running.size;
  }

  async run(job: Job, signal: AbortSignal): Promise<void> {
    const t0 = this.now();
    const handler = this.handlers[job.stage];
    let outcome: StageOutcome;
    try {
      outcome = handler ? await handler(job, signal) : { status: 'skipped', reason: `stage_not_handled_${job.stage}` };
    } catch (err) {
      outcome = { status: 'failed', reason: signal.aborted ? 'worker shutting down' : errorText(err) };
    }
    const reason = outcome.reason ? outcome.reason.slice(0, 500) : null;
    try {
      await this.db.completeJob(job.id, outcome.status, reason);
    } catch (err) {
      // the job stays `running`; the stale check hands it back later
      this.log.log('error', 'complete_failed', { job_id: job.id, stage: job.stage, error: errorText(err) });
      return;
    }
    this.stats[outcome.status]++;
    const final = outcome.status !== 'failed' || job.attempts >= job.max_attempts;
    this.log.log(outcome.status === 'failed' ? (final ? 'error' : 'warn') : 'info', 'job_finished', {
      job_id: job.id, evidence_id: job.evidence_id, stage: job.stage, version: job.pipeline_version, status: outcome.status,
      reason, attempt: job.attempts, final, ms: this.now() - t0,
    });
  }

  /** Stop claiming; wait for running jobs up to the grace period, then abort them (they are handed back). */
  async stop(): Promise<void> {
    if (this.stopping) return this.loopDone ?? undefined;
    this.stopping = true;
    this.stats.stopping = true;
    this.poke();
    await this.loopDone;
    const pending = [...this.running.values()].map((r) => r.done);
    if (pending.length) {
      this.log.log('info', 'draining', { running: pending.length, grace_ms: this.opts.shutdownGraceMs });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graceOver = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.opts.shutdownGraceMs); });
      const result = await Promise.race([Promise.all(pending).then(() => 'drained' as const), graceOver]);
      clearTimeout(timer);
      if (result === 'timeout') {
        for (const r of this.running.values()) r.ctrl.abort();
        await Promise.all([...this.running.values()].map((r) => r.done));
      }
    }
    this.log.log('info', 'stopped', { done: this.stats.done, skipped: this.stats.skipped, failed: this.stats.failed });
  }
}
