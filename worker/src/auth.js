// auth.js — autenticação v1: hash de senha (PBKDF2) e tokens de sessão.
//
// Somente WebCrypto pura — NENHUM acesso a D1 aqui (a camada de banco fica em
// authdb.js). Decisões:
//   - Senha: PBKDF2-SHA256, 100.000 iterações (teto do WebCrypto no Workers —
//     acima disso o deriveBits lança NotSupportedError), salt de 16 bytes aleatórios,
//     formato "pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>" (base64 padrão,
//     via helpers de canonical.js).
//   - Sessão: token opaco de 32 bytes aleatórios em base64url. O token puro
//     vai apenas para o cliente (cookie HttpOnly ou corpo JSON); no banco fica
//     somente o SHA-256 hex do token (ver authdb.js).

import { bytesToBase64, base64ToBytes, bytesToBase64Url } from './canonical.js';

// TTL da sessão: 7 dias (usado no expires_at do banco e no Max-Age do cookie).
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 100k é o máximo suportado pelo runtime Workers (verifyPassword lê as iterações
// do próprio hash gravado, então migrar para um fator maior no futuro é indolor).
const PBKDF2_ITERATIONS = 100000;
const PASSWORD_HASH_PREFIX = 'pbkdf2$sha256$';

// ---------------------------------------------------------------------------
// Senha (PBKDF2-SHA256)
// ---------------------------------------------------------------------------

async function derivePbkdf2(senha, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(senha),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

// Gera o hash de uma senha no formato pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>.
export async function hashPassword(senha) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derivePbkdf2(senha, salt, PBKDF2_ITERATIONS);
  return PASSWORD_HASH_PREFIX + PBKDF2_ITERATIONS + '$' + bytesToBase64(salt) + '$' + bytesToBase64(hash);
}

// Verifica uma senha contra o hash gravado. Formato inválido → false (sem throw).
export async function verifyPassword(senha, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt;
  let expected;
  try {
    salt = base64ToBytes(parts[3]);
    expected = base64ToBytes(parts[4]);
  } catch {
    return false; // base64 malformado
  }
  const actual = await derivePbkdf2(senha, salt, iterations);
  return timingSafeEqual(actual, expected);
}

// Comparação em tempo constante: percorre TODOS os bytes acumulando o XOR,
// sem early-exit. Tamanhos diferentes → false.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Sessão (token opaco + cookie)
// ---------------------------------------------------------------------------

// Token de sessão: 32 bytes aleatórios em base64url (sem padding).
export function newSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// Extrai o token de sessão da requisição: primeiro o cookie "kilo_session",
// senão o header "Authorization: Bearer <token>". Retorna string ou null.
export function getSessionToken(request) {
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === 'kilo_session') {
        const value = part.slice(eq + 1).trim();
        if (value) return value;
      }
    }
  }
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const value = auth.slice('Bearer '.length).trim();
    if (value) return value;
  }
  return null;
}

// Cookie de sessão (7 dias). HttpOnly+Secure: o JS do front NÃO lê o cookie;
// o token também vai no corpo JSON para clientes que preferirem Bearer.
export function sessionCookie(token) {
  return 'kilo_session=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800';
}

// Cookie de expiração imediata (logout).
export function clearSessionCookie() {
  return 'kilo_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
