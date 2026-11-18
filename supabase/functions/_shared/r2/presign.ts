// R2 evidence storage (D13): object key scheme and AWS SigV4 query-string presigning, shared by the
// `field-drain` and `evidence-upload` edge functions (PUT) and `evidence-view` (GET). Pure, no npm imports: runs in Deno and in Node's
// type stripping. Uses WebCrypto (crypto.subtle). Never logs or returns the secret access key.

/** R2 object key; the same convention is enforced by the database. */
export function evidenceKey(caseId: string, taskId: string, sha256: string, ext: string): string {
  return `cases/${caseId}/tasks/${taskId}/${sha256}.${ext}`;
}

/**
 * Key of a shrunk copy the field app made (D51); the database enforces the same scheme
 * (private.derivative_path). Content-addressed by the copy's own hash: other bytes, other key.
 */
export function derivativeKey(caseId: string, originalSha256: string, width: number, copySha256: string): string {
  return `derived/${caseId}/${originalSha256}/w${width}-${copySha256}.jpg`;
}

// ---------------------------------------------------------------------------------------------
// AWS Signature V4, query-string presigning (S3 / R2)
// ---------------------------------------------------------------------------------------------
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function uriEncode(s: string, keepSlash = false): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? e.replace(/%2F/g, '/') : e;
}
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface PresignInput {
  method: 'GET' | 'PUT';
  host: string;
  path: string; // unencoded, starts with '/'
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  expiresSeconds: number;
  /** Extra headers to sign (lower-case names); host is always signed. */
  headers?: Record<string, string>;
  /** Payload hash in the canonical request; defaults to UNSIGNED-PAYLOAD. */
  payloadHash?: string;
  /** Extra signed query parameters (e.g. response-content-disposition on a GET). */
  query?: Record<string, string>;
}

export async function presignUrl(p: PresignInput): Promise<string> {
  const stamp = amzDate(p.date);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${p.region}/${p.service}/aws4_request`;
  const headers: Record<string, string> = { host: p.host, ...(p.headers ?? {}) };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim();
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${p.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(p.expiresSeconds),
    'X-Amz-SignedHeaders': names.join(';'),
    ...(p.query ?? {}),
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');
  const canonicalPath = uriEncode(p.path, true);
  const canonical = [
    p.method, canonicalPath, canonicalQuery,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    p.payloadHash ?? 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmac(enc.encode('AWS4' + p.secretAccessKey), day);
  for (const part of [p.region, p.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `https://${p.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export function readR2Config(get: (k: string) => string | undefined): R2Config | null {
  const accountId = get('R2_ACCOUNT_ID'), bucket = get('R2_BUCKET');
  const accessKeyId = get('R2_ACCESS_KEY_ID'), secretAccessKey = get('R2_SECRET_ACCESS_KEY');
  return accountId && bucket && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
}

export const PUT_EXPIRES_SECONDS = 600;

/**
 * Presigned PUT bound to the file's SHA-256: `x-amz-content-sha256` is a signed header (the canonical
 * payload hash is UNSIGNED-PAYLOAD, as R2 computes it for presigned URLs), so the client must send that
 * header and the store can reject a different body. With `contentLength`, `content-length` is signed too: the store refuses any other
 * size (the HTTP client sets that header from the file, so it is not returned in `headers`).
 */
export async function presignEvidencePut(cfg: R2Config, key: string, sha256: string, now: Date, contentLength?: number): Promise<{
  url: string;
  headers: Record<string, string>;
  expires_in: number;
}> {
  const url = await presignUrl({
    method: 'PUT',
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: 'auto',
    service: 's3',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now,
    expiresSeconds: PUT_EXPIRES_SECONDS,
    headers: contentLength === undefined
      ? { 'x-amz-content-sha256': sha256 }
      : { 'content-length': String(contentLength), 'x-amz-content-sha256': sha256 },
    // R2 builds the canonical request of a presigned URL with UNSIGNED-PAYLOAD, whatever x-amz-content-sha256 says
    // (signing the hash here fails every PUT with SignatureDoesNotMatch, found in the 2026-11-18 E2E run). The hash
    // stays a signed header, so the client cannot change it, and the store compares the body with it.
  });
  return { url, headers: { 'x-amz-content-sha256': sha256 }, expires_in: PUT_EXPIRES_SECONDS };
}

export const GET_EXPIRES_SECONDS = 300;

/**
 * Presigned GET for viewing / downloading one evidence object. `contentType` and
 * `contentDisposition` become the signed `response-content-type` / `response-content-disposition`
 * overrides, so the store answers with the type recorded in the database (not whatever the uploader
 * sent) and the chosen inline / attachment disposition.
 */
export async function presignEvidenceGet(cfg: R2Config, key: string, now: Date, opts: {
  contentType: string;
  contentDisposition: string;
  expiresSeconds?: number;
}): Promise<{ url: string; expires_in: number }> {
  const expires = opts.expiresSeconds ?? GET_EXPIRES_SECONDS;
  const url = await presignUrl({
    method: 'GET',
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: 'auto',
    service: 's3',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: now,
    expiresSeconds: expires,
    query: { 'response-content-disposition': opts.contentDisposition, 'response-content-type': opts.contentType },
  });
  return { url, expires_in: expires };
}
