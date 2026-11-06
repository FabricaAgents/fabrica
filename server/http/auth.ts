// Makers sign in by signing a plain message with their wallet. No email, no password, nothing moves.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { kvGet, kvSet, type DB } from '../db';

export const SESSION_DAYS = 7;
export const COOKIE = 'fab_s';

export function signInMessage(host: string, siteUrl: string, wallet: string, nonce: string, issued: string): string {
  return `${host} wants you to sign in with your Solana account:\n${wallet}\n\nSign in to build and manage agents on Fabrica. This costs nothing and moves no funds.\n\nURI: ${siteUrl}\nNonce: ${nonce}\nIssued At: ${issued}`;
}

export class Auth {
  private secret: string;
  constructor(
    private db: DB,
    private siteUrl: string,
  ) {
    let s = kvGet(db, 'cookie_secret');
    if (!s) {
      s = randomBytes(32).toString('hex');
      kvSet(db, 'cookie_secret', s);
    }
    this.secret = s;
  }

  private mac(id: string) {
    return createHmac('sha256', this.secret).update(id).digest('base64url').slice(0, 32);
  }

  nonce(wallet: string): { nonce: string; message: string } {
    try {
      new PublicKey(wallet);
    } catch {
      throw new Error('That is not a Solana address.');
    }
    const nonce = randomBytes(12).toString('hex');
    const issued = new Date().toISOString();
    this.db.prepare('INSERT INTO auth_nonces (nonce, wallet, created_at) VALUES (?, ?, ?)').run(nonce, wallet, Date.now());
    return { nonce, message: signInMessage(new URL(this.siteUrl).host, this.siteUrl, wallet, nonce, issued) };
  }

  /** Checks the signature over the exact message issued and opens a session. Returns the cookie value. */
  verify(wallet: string, nonce: string, message: string, signature: string): string {
    const row = this.db.prepare('SELECT * FROM auth_nonces WHERE nonce = ?').get(nonce) as { wallet: string; created_at: number; used: number } | undefined;
    if (!row || row.used || row.wallet !== wallet || Date.now() - row.created_at > 10 * 60_000) throw new Error('That sign-in request expired. Try again.');
    if (!message.includes(`\nNonce: ${nonce}\n`) || !message.startsWith(`${new URL(this.siteUrl).host} wants you to sign in`) || !message.includes(`\n${wallet}\n`)) throw new Error('The signed message is not the one Fabrica issued.');
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature), new PublicKey(wallet).toBytes());
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('The signature does not match the wallet.');
    this.db.prepare('UPDATE auth_nonces SET used = 1 WHERE nonce = ?').run(nonce);
    const id = randomBytes(18).toString('base64url');
    this.db.prepare('INSERT INTO sessions (id, wallet, created_at, expires_at) VALUES (?, ?, ?, ?)').run(id, wallet, Date.now(), Date.now() + SESSION_DAYS * 86_400_000);
    return `${id}.${this.mac(id)}`;
  }

  wallet(cookieHeader: string | undefined): string | null {
    const raw = String(cookieHeader ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const [id, mac] = raw.slice(COOKIE.length + 1).split('.');
    if (!id || !mac) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(this.mac(id));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const row = this.db.prepare('SELECT wallet, expires_at FROM sessions WHERE id = ?').get(id) as { wallet: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return null;
    return row.wallet;
  }

  logout(cookieHeader: string | undefined) {
    const raw = String(cookieHeader ?? '').match(new RegExp(`${COOKIE}=([^.;]+)`));
    if (raw) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(raw[1]);
  }

  cookie(value: string, secure: boolean): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export function adminOk(header: string | undefined, token: string | null): boolean {
  if (!token || token.length < 24) return false;
  const got = String(header ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
