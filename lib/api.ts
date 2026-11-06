'use client';
// Small JSON helpers for the in-page apps.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: { ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok && res.status !== 402) throw new ApiError(res.status, body?.error ?? 'error', body?.message ?? `Request failed (${res.status})`, body);
  return { status: res.status, body, headers: res.headers };
}
