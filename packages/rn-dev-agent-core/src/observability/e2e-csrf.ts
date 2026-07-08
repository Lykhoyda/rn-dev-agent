import { randomBytes, timingSafeEqual } from 'node:crypto';

export function makeCsrfToken(): string {
  return randomBytes(24).toString('hex');
}

interface ReqLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function isPostAllowed(
  req: ReqLike,
  token: string,
): { ok: true } | { ok: false; status: number; reason: string } {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    return { ok: false, status: 405, reason: 'method not allowed' };
  }
  const gotRaw = req.headers['x-csrf-token'];
  if (gotRaw !== undefined) {
    const got = String(gotRaw);
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, status: 403, reason: 'bad csrf token' };
    }
  }
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.includes('application/json')) {
    return { ok: false, status: 415, reason: 'content-type must be application/json' };
  }
  if (gotRaw === undefined) {
    return { ok: false, status: 403, reason: 'bad csrf token' };
  }
  return { ok: true };
}
