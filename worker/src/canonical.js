// canonical.js — serialização JSON canônica (determinística) + helpers de hash e base64.
//
// O JSON canônico é usado em TODOS os hashes e na assinatura Ed25519 do passaporte:
//   - chaves de objetos ordenadas recursivamente (ordenação por code unit UTF-16, padrão do JS);
//   - sem espaços/indentação;
//   - arrays preservam a ordem original;
//   - strings escapadas via JSON.stringify (não-ASCII permanece literal; o hash é sobre UTF-8).
// Qualquer mudança aqui altera ruleset_hash, input_hash, evidence_manifest_hash e a assinatura.

export function canonicalStringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalStringify: número não finito');
    return JSON.stringify(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
  }
  throw new Error('canonicalStringify: tipo não suportado: ' + t);
}

// SHA-256 hex (minúsculo) do JSON canônico de um valor arbitrário.
export async function sha256HexCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

// SHA-256 hex (minúsculo) de uma string, codificada em UTF-8.
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToBase64(bytes) {
  // Monta em blocos para não estourar pilha/argumentos em payloads grandes.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Hex aleatório (usado em ids de passaporte: psp_<12hex>).
export function randomHex(nChars) {
  const bytes = new Uint8Array(Math.ceil(nChars / 2));
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes).slice(0, nChars);
}

// Base32 Crockford (sem I/L/O/U), usado em ids "ULID-like" de lead: lead_<26 chars>.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function randomBase32(nChars) {
  const bytes = new Uint8Array(nChars);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < nChars; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}
