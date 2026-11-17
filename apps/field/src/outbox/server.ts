// Server calls the outbox needs, behind interfaces so the engine is tested with fakes.
// Real implementations: signedInServer.ts (JWT, post_thread_message / report_outbox_status) and
// drainServer.ts (field-drain edge function after remote sign-out).

/**
 * transient     network, 5xx, timeouts: retry with backoff
 * window_closed 42501 + hint upload_window_closed (D43 late-upload rule)
 * rejected      other refusals (invalid input, duplicate): hold for the office
 * auth          session refused (deactivated / banned): stop; the app checks field-drain `status`
 * drain_closed  drain window over, finished, or unknown device: stop; the app finishes and wipes
 * reactivated   drain answered not_deactivated: back to normal sign-in
 */
export type ServerErrorKind = 'transient' | 'window_closed' | 'rejected' | 'auth' | 'drain_closed' | 'reactivated';

export class ServerError extends Error {
  readonly kind: ServerErrorKind;
  readonly code: string;
  constructor(kind: ServerErrorKind, code: string, message?: string) {
    super(message ?? code);
    this.kind = kind;
    this.code = code;
  }
}

export interface PresignRequest {
  case_id: string;
  task_id: string;
  sha256: string;
  ext: string;
  device_captured_at: string;
  /** The signed-in presigner binds the PUT to this size and checks the type (evidence-upload). */
  size_bytes: number;
  mime_type: string;
}

export interface Presigned {
  storage_path: string;
  url: string;
  /** Must be sent with the PUT (x-amz-content-sha256). */
  headers: Record<string, string>;
  /** The case already stores this file (same sha256, rule 6): skip the PUT, still post it. */
  already_stored?: boolean;
}

/** One file as post_thread_message / field-drain `post` expect it in p_items. */
export interface PostItem {
  evidence_type: string;
  capture_source: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  original_filename: string | null;
  device_captured_at: string;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy_m: number | null;
  checklist_item_id: string | null;
  category_code: string | null;
  device_info?: Record<string, unknown>;
  exif?: Record<string, unknown>;
  ocr?: unknown;
}

export interface PostMessage {
  case_id: string;
  client_message_id: string;
  kind: 'text' | 'media' | 'voice';
  body: string | null;
  task_id: string | null;
  reply_to: string | null;
  items: PostItem[];
}

export interface OutboxReport {
  device_id: string;
  pending_count: number;
  pending_bytes: number;
  /** Device clock: capture time of the oldest waiting file. */
  oldest_pending_at: string | null;
}

/** Copies of one photo to presign (evidence-upload `derivatives`). */
export interface DerivativePresignRequest {
  case_id: string;
  task_id: string;
  original_sha256: string;
  copies: { width: 384 | 1600; sha256: string; size_bytes: number }[];
}

export interface DerivativePresign {
  width: number;
  status: 'upload' | 'already_stored' | 'skipped';
  storage_path?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface DerivativeRecord {
  case_id: string;
  original_sha256: string;
  width: 384 | 1600;
  storage_path: string;
  sha256: string;
  size_bytes: number;
  pixel_width: number;
  pixel_height: number;
}

export interface Server {
  /** Presigned R2 PUT for one file. */
  presign(req: PresignRequest): Promise<Presigned>;
  /**
   * Shrunk copies (D51). Optional: the drain server has neither, so copies are not sent after a
   * remote sign-out.
   */
  presignDerivatives?(req: DerivativePresignRequest): Promise<DerivativePresign[]>;
  /** `record_device_derivative`; idempotent. */
  recordDerivative?(rec: DerivativeRecord): Promise<void>;
  /** Idempotent on client_message_id; returns the server message id. */
  postMessage(msg: PostMessage): Promise<string>;
  reportOutbox(report: OutboxReport): Promise<void>;
}

/** Moves bytes from the sandbox to the presigned URL. */
export interface Transport {
  put(url: string, headers: Record<string, string>, localPath: string, onProgress: (bytesSent: number) => void): Promise<void>;
}

export type DrainState = 'drain' | 'active' | 'closed';

/** field-drain extras beyond the Server calls. */
export interface DrainServer extends Server {
  status(): Promise<{ state: DrainState; deactivated_at: string | null; drain_until: string | null }>;
  finish(discardedCount: number): Promise<void>;
}

export interface PgErrorLike {
  code?: string | null;
  hint?: string | null;
  message?: string | null;
  status?: number | null;
}

/** Map a PostgREST / supabase-js error from post_thread_message or report_outbox_status. */
export function classifyPgError(e: PgErrorLike): ServerError {
  const code = e.code ?? '';
  const msg = e.message ?? code;
  if (code === '42501' && e.hint === 'upload_window_closed') return new ServerError('window_closed', 'upload_window_closed', msg);
  if (code === 'PGRST301' || code === 'PGRST302' || e.status === 401) return new ServerError('auth', code || 'unauthorized', msg);
  if (code === '42501' || code === '22023' || code === '23505' || code === '23503' || code === '22P02') {
    return new ServerError('rejected', code, msg);
  }
  return new ServerError('transient', code || 'unknown', msg);
}

/** Map a field-drain `{ok:false, error:{code}}` reply. */
export function classifyDrainError(status: number, code: string | undefined): ServerError {
  switch (code) {
    case 'upload_window_closed':
      return new ServerError('window_closed', code);
    case 'not_deactivated':
      return new ServerError('reactivated', code);
    case 'device_unknown':
    case 'drain_window_closed':
    case 'drain_finished':
      return new ServerError('drain_closed', code);
    case 'invalid_input':
    case 'invalid_body':
      return new ServerError('rejected', code);
    default:
      return new ServerError('transient', code ?? `http_${status}`);
  }
}
