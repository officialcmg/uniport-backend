/**
 * App IDs: the public identifier a developer puts in their code.
 *
 *   app_ + 22 base62 characters = 12 random bytes followed by a 4-byte tag
 *
 * The tag is the start of an HMAC of the random bytes, keyed with
 * APP_ID_HMAC_SECRET. It lets the Worker reject a made-up ID without asking
 * the database, so guessing IDs cannot be turned into database load. It is not
 * what makes an ID valid: the ID must also exist in the app_ids table.
 *
 * The dashboard (uniport-landing, lib/app-id.ts) creates IDs the same way with
 * the same secret. Both check the vector in test/app-id.test.ts; keep the two
 * files in step.
 */

const PREFIX = 'app_';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ENCODED_LENGTH = 22;
const RANDOM_BYTES = 12;
const TAG_BYTES = 4;
const DOMAIN = new TextEncoder().encode('uniport-app-id-v1');
const FORMAT = /^app_[0-9A-Za-z]{22}$/;

/** True if the value has the shape of an App ID. Says nothing about its tag. */
export function looksLikeAppId(value: string): boolean {
    return FORMAT.test(value);
}

function encode(bytes: Uint8Array): string {
    let n = 0n;
    for (const byte of bytes) n = (n << 8n) | BigInt(byte);
    let out = '';
    while (n > 0n) {
        out = ALPHABET[Number(n % 62n)] + out;
        n /= 62n;
    }
    return out.padStart(ENCODED_LENGTH, '0');
}

function decode(encoded: string): Uint8Array | null {
    let n = 0n;
    for (const char of encoded) {
        const digit = ALPHABET.indexOf(char);
        if (digit < 0) return null;
        n = n * 62n + BigInt(digit);
    }
    const bytes = new Uint8Array(RANDOM_BYTES + TAG_BYTES);
    for (let i = bytes.length - 1; i >= 0; i--) {
        bytes[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    // Anything left over means the text encoded more than 16 bytes.
    return n === 0n ? bytes : null;
}

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
    let key = keys.get(secret);
    if (!key) {
        key = crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        keys.set(secret, key);
        // Do not keep a failed import for the life of the instance.
        key.catch(() => keys.delete(secret));
    }
    return key;
}

async function tagFor(random: Uint8Array, secret: string): Promise<Uint8Array> {
    const message = new Uint8Array(DOMAIN.length + random.length);
    message.set(DOMAIN);
    message.set(random, DOMAIN.length);
    const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), message);
    return new Uint8Array(mac).subarray(0, TAG_BYTES);
}

/** Makes an App ID from the given random bytes; exported for the shared test vector. */
export async function appIdFromRandom(random: Uint8Array, secret: string): Promise<string> {
    if (random.length !== RANDOM_BYTES) throw new Error(`Expected ${RANDOM_BYTES} random bytes.`);
    const bytes = new Uint8Array(RANDOM_BYTES + TAG_BYTES);
    bytes.set(random);
    bytes.set(await tagFor(random, secret), RANDOM_BYTES);
    return PREFIX + encode(bytes);
}

/** Makes a new App ID. */
export function generateAppId(secret: string): Promise<string> {
    return appIdFromRandom(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)), secret);
}

/** True if the ID was made with this secret. It may still not exist, or be disabled. */
export async function verifyAppId(id: string, secret: string): Promise<boolean> {
    if (!looksLikeAppId(id)) return false;
    const bytes = decode(id.slice(PREFIX.length));
    if (!bytes) return false;
    const expected = await tagFor(bytes.subarray(0, RANDOM_BYTES), secret);
    let difference = 0;
    for (let i = 0; i < TAG_BYTES; i++) difference |= bytes[RANDOM_BYTES + i] ^ expected[i];
    return difference === 0;
}
