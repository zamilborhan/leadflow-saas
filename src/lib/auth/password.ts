/**
 * Password hashing for LeadFlow BD.
 *
 * scrypt (Node.js built-in) with per-password random salt. No third-party
 * dependency. Format is self-describing so parameters can evolve:
 *   scrypt$v=1$n=16384$r=8$p=1$<saltB64>$<hashB64>
 */
import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/** Promisified scrypt with explicit options (util.promisify picks the wrong overload). */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

const HASH_VERSION = 1;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_PASSWORD_LENGTH = 128;

/** Dummy hash used to equalize timing when the account does not exist. */
const DUMMY_HASH = (() => {
  const salt = Buffer.alloc(SALT_BYTES, 0x51);
  // NOTE: not a real scrypt output; only its shape matters for the fallback path.
  const key = Buffer.alloc(KEY_BYTES, 0x52);
  return encode(HASH_VERSION, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
})();

function encode(
  v: number,
  n: number,
  r: number,
  p: number,
  salt: Buffer,
  key: Buffer
): string {
  return [
    "scrypt",
    `v=${v}$n=${n}$r=${r}$p=${p}`,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): ParsedHash | null {
  // Format: scrypt$v=<v>$n=<n>$r=<r>$p=<p>$<saltB64>$<keyB64> (7 segments).
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return null;
  const params = new Map<string, number>();
  for (const kv of parts.slice(1, 5)) {
    const [k, raw] = kv.split("=");
    const num = Number(raw);
    if (!k || !Number.isSafeInteger(num)) return null;
    params.set(k, num);
  }
  const n = params.get("n") ?? NaN;
  const r = params.get("r") ?? NaN;
  const p = params.get("p") ?? NaN;
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return null;
  }
  // Refuse absurd parameters that could be used for DoS.
  if (n > 1 << 20 || r > 32 || p > 8) return null;
  let salt: Buffer;
  let key: Buffer;
  try {
    salt = Buffer.from(parts[5], "base64");
    key = Buffer.from(parts[6], "base64");
  } catch {
    return null;
  }
  if (salt.length === 0 || key.length === 0) return null;
  return { n, r, p, salt, key };
}

/** Hash a password. Throws if the password exceeds the length cap. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Invalid password length");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = (await scryptAsync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return encode(HASH_VERSION, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
}

/**
 * Verify a password against a stored hash. Returns false (never throws) for
 * malformed hashes. Uses constant-time comparison.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  let candidate: Buffer;
  try {
    candidate = (await scryptAsync(password, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
    })) as Buffer;
  } catch {
    return false;
  }
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * Timing-equalized fallback for unknown accounts: burns one scrypt pass so
 * "unknown email" and "wrong password" take comparable time.
 */
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}
