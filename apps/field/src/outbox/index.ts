// Pure public API (safe to import in tests). Native wiring: ./runtime, ./useOutbox, ./background.
export * from './types';
export * from './selectors';
export { Outbox, toPostMessage, type OutboxDeps, type OutboxEvent, type OutboxMode, type OutboxSnapshot } from './outbox';
export { ServerError, type DrainServer, type Server, type Transport } from './server';
export { MemoryStore, type Store } from './store';
export { backoffDelay, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from './backoff';
export { canTransition } from './stateMachine';
