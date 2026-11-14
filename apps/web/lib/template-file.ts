/** Checks for the insurer report template upload (DB4: .docx only, 10 MiB). Pure; the server action re-runs them. */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

export function checkTemplateFile(f: { name: string; size: number; type?: string }, head?: Uint8Array): string | null {
  if (!/\.docx$/i.test(f.name)) return "Only Word .docx files can be uploaded.";
  if (f.size <= 0) return "The file is empty.";
  if (f.size > MAX_TEMPLATE_BYTES) return "The file is larger than 10 MB.";
  if (f.type && f.type !== DOCX_MIME && f.type !== "application/octet-stream") return "Only Word .docx files can be uploaded.";
  // .docx is a zip archive: starts with "PK"
  if (head && !(head[0] === 0x50 && head[1] === 0x4b)) return "This does not look like a Word .docx file.";
  return null;
}

/** Letters, digits, dot, dash, underscore only; at most 80 chars before the extension. */
export function safeFileName(name: string): string {
  const base = name
    .replace(/\.docx$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${base || "template"}.docx`;
}

/** `{insurer_id}/{yyyyMMdd-HHmmss}-{safe-name}.docx`, timestamp in UTC. */
export function templatePath(insurerId: string, fileName: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${insurerId}/${ts}-${safeFileName(fileName)}`;
}

/** Shows the stored file name without the folder and timestamp prefix. */
export function templateDisplayName(path: string | null): string | null {
  if (!path) return null;
  return (path.split("/").pop() ?? path).replace(/^\d{8}-\d{6}-/, "");
}
