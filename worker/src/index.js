// index.js — entrypoint do Worker "kilo-passaporte" (API /api/*).
// POST /api/passaporte é handlePassaporte em src/emit.js (v2: nasce do motor).

import { RULESET, RULESET_HASH, RULESET_VERSION } from './ruleset.js';
import { computePricing, GRADE_G, DEFAULT_I, DEFAULT_T } from './pricing.js';
import {
  jsonResponse,
  errorResponse,
  parseJsonBody,
  isNonEmptyString,
  isValidEmail,
} from './validate.js';
import { checkRateLimit } from './ratelimit.js';
import { handleScan } from './scan.js';
import { handlePassaporte } from './emit.js';
import {
  verifyPassaporte,
  extractPassaporte,
  hasSigningKey,
  getPublicJwk,
} from './passport.js';
import { randomBase32 } from './canonical.js';
import { CLOSING_CHECKLIST, CLOSING_CHECKLIST_HASH } from './closing.js';
import {
  handleRegistroRegister,
  handleRegistroList,
  handleRegistroGet,
  handleRegistroEvent,
} from './registro.js';
import {
  hashPassword,
  verifyPassword,
  getSessionToken,
  sessionCookie,
  clearSessionCookie,
} from './auth.js';
import {
  createUser,
  findUserByEmail,
  createSession,
  getUserBySession,
  deleteSession,
} from './authdb.js';

const RATE_LIMITS = {
  'GET /api/desagio': 60,
  'POST /api/lead': 10,
  'POST /api/passaporte': 10,
  'POST /api/scan': 10,
  'POST /api/verify': 60,
  'POST /api/auth/register': 5,
  'POST /api/auth/login': 10,
  'POST /api/registro': 20,
  'GET /api/registro': 60,
};
const DEFAULT_RATE_LIMIT = 120;
const MAX_VN = 1e13;
const MAX_AMOUNT_CENTS = 1e15;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env, ctx) {
    const corsOrigin = resolveCorsOrigin(request, env);
    try {
      const response = await route(request, env, ctx, corsOrigin);
      return withCors(response, corsOrigin);
    } catch (err) {
      console.error('erro interno:', err && err.message);
      return withCors(errorResponse(500, 'INTERNAL', 'Erro interno.'), corsOrigin);
    }
  },
};

function resolveCorsOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin');
  if (allowed.includes('*')) return '*';
  if (origin && allowed.includes(origin)) return origin;
  return null;
}

function withCors(response, corsOrigin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') headers.set('Vary', 'Origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleOptions(corsOrigin) {
  const headers = new Headers(SECURITY_HEADERS);
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'content-type, authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

async function route(request, env, ctx, corsOrigin) {
  if (request.method === 'OPTIONS') return handleOptions(corsOrigin);
  const url = new URL(request.url);
  const path = url.pathname;
  const routeKey = request.method + ' ' + path;
  const HANDLERS = {
    'GET /api/health': handleHealth,
    'GET /api/pubkey': handlePubkey,
    'GET /api/ruleset': handleRuleset,
    'GET /api/closing/checklist': handleClosingChecklist,
    'GET /api/desagio': handleDesagio,
    'POST /api/passaporte': handlePassaporte,
    'POST /api/verify': handleVerify,
    'POST /api/lead': handleLead,
    'POST /api/scan': handleScan,
    'POST /api/auth/register': handleAuthRegister,
    'POST /api/auth/login': handleAuthLogin,
    'POST /api/auth/logout': handleAuthLogout,
    'GET /api/me': handleMe,
    'POST /api/registro': handleRegistroRegister,
    'GET /api/registro': handleRegistroList,
  };
  let handler = HANDLERS[routeKey];
  // Rotas dinâmicas: /api/registro/{passport_id} (GET = consulta, POST = evento).
  if (!handler && path.startsWith('/api/registro/')) {
    const registroId = decodeURIComponent(path.slice('/api/registro/'.length)).trim();
    if (request.method === 'GET') handler = (req, e) => handleRegistroGet(req, e, registroId);
    else if (request.method === 'POST') handler = (req, e) => handleRegistroEvent(req, e, registroId);
    else return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Método não permitido nesta rota.');
  }
  if (!handler) {
    const knownPath = Object.keys(HANDLERS).some((k) => k.endsWith(' ' + path));
    if (knownPath) return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Método não permitido nesta rota.');
    return errorResponse(404, 'NOT_FOUND', 'Rota não encontrada.');
  }
  const limit = RATE_LIMITS[routeKey] || DEFAULT_RATE_LIMIT;
  const ip = request.headers.get('cf-connecting-ip');
  const rl = await checkRateLimit(env, routeKey, limit, ip);
  if (!rl.allowed) {
    return jsonResponse(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Muitas requisições — tente novamente em instantes.',
          retry_after: rl.retryAfter,
        },
      },
      429,
      { 'Retry-After': String(rl.retryAfter) }
    );
  }
  return handler(request, env, url);
}

function handleHealth() {
  return jsonResponse({ ok: true, service: 'passaporte-fiscal', ruleset: RULESET_VERSION });
}

function handlePubkey(request, env) {
  if (!hasSigningKey(env)) return noSigningKey();
  try {
    return jsonResponse({
      alg: 'Ed25519',
      public_jwk: getPublicJwk(env),
      ephemeral: false,
      note: 'Chave estável (secret configurado).',
    });
  } catch {
    return noSigningKey();
  }
}

function noSigningKey() {
  return errorResponse(503, 'NO_SIGNING_KEY', 'Chave de assinatura não configurada.');
}

function handleRuleset() {
  return jsonResponse({ ruleset: RULESET, ruleset_hash: RULESET_HASH });
}

function handleClosingChecklist() {
  return jsonResponse({ checklist: CLOSING_CHECKLIST, checklist_hash: CLOSING_CHECKLIST_HASH });
}

function handleDesagio(request, env, url) {
  const q = url.searchParams;
  const vnRaw = q.get('vn');
  const vn = vnRaw === null || vnRaw.trim() === '' ? NaN : Number(vnRaw);
  if (!Number.isFinite(vn) || vn <= 0 || vn > MAX_VN) {
    return errorResponse(400, 'INVALID_VN', 'Informe vn numérico maior que zero (valor de face em reais).', 'vn');
  }
  const rating = q.get('rating');
  if (!rating || !Object.prototype.hasOwnProperty.call(GRADE_G, rating)) {
    return errorResponse(400, 'INVALID_RATING', 'Rating inválido — use A, B ou C.', 'rating');
  }
  const iRaw = q.get('i');
  const i = iRaw === null || iRaw.trim() === '' ? DEFAULT_I : Number(iRaw);
  if (!Number.isFinite(i) || i < 0 || i > 0.2) {
    return errorResponse(400, 'INVALID_I', 'Taxa i inválida — número no intervalo [0, 0.20].', 'i');
  }
  const tRaw = q.get('T');
  const T = tRaw === null || tRaw.trim() === '' ? DEFAULT_T : Number(tRaw);
  if (!Number.isFinite(T) || !Number.isInteger(T) || T < 1 || T > 360) {
    return errorResponse(400, 'INVALID_T', 'Prazo T inválido — inteiro entre 1 e 360 meses.', 'T');
  }
  const amountCents = Math.round(vn * 100);
  return jsonResponse(computePricing(amountCents, rating, i, T));
}

async function handleVerify(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const passaporte = extractPassaporte(parsed.value);
  if (!passaporte) {
    return errorResponse(400, 'INVALID_PASSAPORTE', 'Envie o passaporte em {"passaporte": {...}} (ou o objeto direto).', 'passaporte');
  }
  if (!hasSigningKey(env) && !isNonEmptyString(env.SIGNING_KEY_JWK_PREVIOUS)) return noSigningKey();
  const { valid, verifiedWith } = await verifyPassaporte(env, passaporte);
  return jsonResponse({ valid, verified_with: verifiedWith || 'Ed25519 / stable' });
}

async function handleLead(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (isNonEmptyString(body.website)) {
    return jsonResponse({ id: 'lead_' + randomBase32(26) }, 201);
  }
  if (typeof body.nome !== 'string' || body.nome.trim().length < 2) {
    return errorResponse(400, 'INVALID_LEAD', 'Informe seu nome (mínimo de 2 caracteres).', 'nome');
  }
  if (!isValidEmail(body.email)) {
    return errorResponse(400, 'INVALID_LEAD', 'Informe um e-mail válido.', 'email');
  }
  if (body.empresa !== undefined && body.empresa !== null && typeof body.empresa !== 'string') {
    return errorResponse(400, 'INVALID_LEAD', 'Campo empresa deve ser texto.', 'empresa');
  }
  if (
    body.valor_credito !== undefined &&
    body.valor_credito !== null &&
    (typeof body.valor_credito !== 'number' || !Number.isFinite(body.valor_credito) || body.valor_credito < 0)
  ) {
    return errorResponse(400, 'INVALID_LEAD', 'Campo valor_credito deve ser um número não negativo.', 'valor_credito');
  }
  if (body.simulacao !== undefined && body.simulacao !== null && (typeof body.simulacao !== 'object' || Array.isArray(body.simulacao))) {
    return errorResponse(400, 'INVALID_LEAD', 'Campo simulacao deve ser um objeto JSON.', 'simulacao');
  }
  if (!env.DB) {
    return errorResponse(503, 'LEADS_UNAVAILABLE', 'Captura temporariamente indisponível.');
  }
  const id = 'lead_' + randomBase32(26);
  try {
    await env.DB.prepare(
      `INSERT INTO leads (id, nome, email, empresa, valor_credito, simulacao, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        body.nome.trim(),
        body.email.trim(),
        body.empresa != null ? String(body.empresa).trim() : null,
        body.valor_credito != null ? body.valor_credito : null,
        body.simulacao != null ? JSON.stringify(body.simulacao) : null,
        request.headers.get('cf-connecting-ip') || null,
        request.headers.get('user-agent') || null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    console.error('falha ao gravar lead:', err && err.message);
    return errorResponse(503, 'LEADS_UNAVAILABLE', 'Captura temporariamente indisponível.');
  }
  return jsonResponse({ id }, 201);
}

function authUnavailable() {
  return errorResponse(503, 'AUTH_UNAVAILABLE', 'Autenticação temporariamente indisponível.');
}

async function handleAuthRegister(request, env) {
  if (!env.DB) return authUnavailable();
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.nome !== 'string' || body.nome.trim().length < 2) {
    return errorResponse(400, 'INVALID_NOME', 'Informe seu nome (mínimo de 2 caracteres).', 'nome');
  }
  if (!isValidEmail(body.email)) {
    return errorResponse(400, 'INVALID_EMAIL', 'Informe um e-mail válido.', 'email');
  }
  if (typeof body.senha !== 'string' || body.senha.length < 8) {
    return errorResponse(400, 'AUTH_WEAK_PASSWORD', 'Senha deve ter ao menos 8 caracteres.', 'senha');
  }
  if (!isNonEmptyString(body.org_id)) {
    return errorResponse(400, 'INVALID_ORG_ID', 'Informe org_id (identificador da organização).', 'org_id');
  }
  const email = body.email.trim().toLowerCase();
  const senhaHash = await hashPassword(body.senha);
  const created = await createUser(env, {
    org_id: body.org_id.trim(),
    nome: body.nome.trim(),
    email,
    senha_hash: senhaHash,
  });
  if (!created.ok) {
    return errorResponse(409, 'EMAIL_TAKEN', 'E-mail já cadastrado.', 'email');
  }
  const session = await createSession(env, created.user.id, request);
  const res = jsonResponse(
    { user: created.user, session_token: session.token, session_expires_at: session.expires_at },
    201
  );
  res.headers.append('Set-Cookie', sessionCookie(session.token));
  return res;
}

const DUMMY_PASSWORD_HASH =
  'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function handleAuthLogin(request, env) {
  if (!env.DB) return authUnavailable();
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.email !== 'string' || typeof body.senha !== 'string') {
    return errorResponse(400, 'INVALID_CREDENTIALS_FORMAT', 'Informe e-mail e senha.');
  }
  const email = body.email.trim().toLowerCase();
  const user = await findUserByEmail(env, email);
  const ok = await verifyPassword(body.senha, user ? user.senha_hash : DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    return errorResponse(401, 'AUTH_FAILED', 'Credenciais inválidas.');
  }
  const session = await createSession(env, user.id, request);
  const res = jsonResponse({
    user: { id: user.id, org_id: user.org_id, nome: user.nome, email: user.email },
    session_token: session.token,
    session_expires_at: session.expires_at,
  });
  res.headers.append('Set-Cookie', sessionCookie(session.token));
  return res;
}

async function handleAuthLogout(request, env) {
  if (!env.DB) return authUnavailable();
  const token = getSessionToken(request);
  if (token) await deleteSession(env, token);
  const res = jsonResponse({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie());
  return res;
}

async function handleMe(request, env) {
  if (!env.DB) return authUnavailable();
  const token = getSessionToken(request);
  const session = token ? await getUserBySession(env, token) : null;
  if (!session) {
    return errorResponse(401, 'AUTH_REQUIRED', 'Sessão ausente ou expirada.');
  }
  return jsonResponse({ user: session.user, session_expires_at: session.expires_at });
}
