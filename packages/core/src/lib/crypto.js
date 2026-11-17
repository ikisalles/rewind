// Web Crypto helpers. Only standard APIs, so they run on Cloudflare Workers,
// Azion Functions, Deno and Node 20+.

const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

export function randomToken(bytes = 24) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Time-ordered id: keys list in creation order, even for ids created in the
// same millisecond (a per-instance counter breaks the tie before the random part).
let lastMs = 0;
let seq = 0;
export function newId() {
  const ms = Date.now();
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  return ms.toString(36).padStart(9, '0') + seq.toString(36).padStart(3, '0') + randomToken(6);
}

// PBKDF2 is available everywhere; 100k iterations is the Cloudflare Workers ceiling.
const ITERATIONS = 100_000;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, iter, saltHex, hashHex] = stored.split('$');
  const bits = toHex(await derive(password, fromHex(saltHex), Number(iter)));
  // constant-time-ish comparison
  let diff = bits.length ^ hashHex.length;
  for (let i = 0; i < bits.length; i++) diff |= bits.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
