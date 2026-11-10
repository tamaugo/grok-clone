import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { libraryFor } from './agent/claude.js';
import type { Attachment } from './types.js';

/**
 * Image attachments pasted or dropped into the composer. Files live in the chat's own
 * library folder (`library/uploads/`), so they also show up in the Library. The Bot sees
 * them through the Read tool: the turn prompt lists their absolute paths.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const UPLOAD_DIR = 'uploads';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** The image type from the file's magic bytes; the client's Content-Type isn't trusted. */
export function sniffImage(buf: Uint8Array): string | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export const uploadsDir = (botId: string) => path.join(libraryFor(botId), UPLOAD_DIR);

export function saveUpload(botId: string, buf: Uint8Array): Attachment {
  const mime = sniffImage(buf);
  if (!mime) throw new UploadError(415, 'Only PNG, JPEG, GIF or WebP images can be attached.');
  if (buf.byteLength > MAX_UPLOAD_BYTES) throw new UploadError(413, 'Images can be at most 10 MB.');
  if (buf.byteLength === 0) throw new UploadError(400, 'Empty file.');
  const dir = uploadsDir(botId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `screenshot-${stamp}-${crypto.randomBytes(4).toString('hex')}.${EXT[mime]}`;
  fs.writeFileSync(path.join(dir, name), buf, { mode: 0o644 });
  return { kind: 'image', name, mime, size: buf.byteLength };
}

/** An uploaded file of this chat, or null if the name is unsafe or the file is missing. */
export function findUpload(botId: string, name: string): (Attachment & { abs: string }) | null {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const mime = MIME_BY_EXT[name.split('.').pop()!.toLowerCase()];
  if (!mime) return null;
  const abs = path.join(uploadsDir(botId), name);
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  return { kind: 'image', name, mime, size: st.size, abs };
}

/** The sentence added to a Bot's turn so it looks at the attached images. */
export function imagesNote(paths: string[]): string {
  if (!paths.length) return '';
  return `[The user attached ${paths.length === 1 ? 'an image' : `${paths.length} images`}. Look at ${paths.length === 1 ? 'it' : 'each one'} with the Read tool before you answer:]\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

export class UploadError extends Error {
  constructor(public status: 400 | 413 | 415, message: string) { super(message); }
}
