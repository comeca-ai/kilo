// index.js — entrypoint do Worker "kilo-passaporte" (API /api/*).
//
// Static Assets: com [assets] no wrangler.toml, a borda serve os arquivos de
// ./public quando o caminho casa um asset (ex.: "/" → public/index.html) e só
// invoca este fetch quando NÃO há asset correspondente — ou seja, /api/*
// sempre chega aqui. Por isso não existe handler de "/" neste arquivo.
//
// Roteamento manual por URL.pathname (sem framework). Responsabilidades transversais:
//   1. CORS (allowlist via env ALLOWED_ORIGINS, csv; default "*") + preflight OPTIONS;
//   2. Rate limit por rota/IP (janela fixa; ver src/ratelimit.js);
//   3. Catch global sem vazamento de stacktrace -> 500 {"error":{"code":"INTERNAL",...}}.
//
// Contrato de produção reproduzido fielmente (ver API.md). Mudanças intencionais em
// relação ao comportamento silencioso antigo: validações 400 em entradas inválidas.

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
import {
  buildPassaporte,
  signPassaporte,
  verifyPassaporte,
  extractPassaporte,
  hasSigningKey,
  getPublicJwk,
} from './passport.js';
import { randomBase32 } from './canonical.js';
import { CLOSING_CHECKLIST, CLOSING_CHECKLIST_HASH } from './closing.js';
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

// Limites por rota (requisições/minuto, janela fixa por IP). Demais rotas: 120/min.
const RATE_LIMITS = {
  'GET /api/desagio': 60,
  'POST /api/lead': 10,
  'POST /api/passaporte': 10,
  'POST /api/scan': 10,
  'POST /api/verify': 60,
  'POST /api/auth/register': 10,
  'POST /api/auth/login': 10,
};
const DEFAULT_RATE_LIMIT = 120;

// Teto absoluto de valor para evitar números absurdos/overflow de precisão (R$ 100 bi em centavos).
const MAX_VN = 1e13;
const MAX_AMOUNT_CENTS = 1e15;

export default {
  async fetch(request, env, ctx) {
    const corsOrigin = resolveCorsOrigin(request, env);
    try {
      const response = await route(request, env, ctx, corsOrigin);
      return withCors(response, corsOrigin);
    } catch (err) {
      // Sem stacktrace na resposta; detalhe fica apenas no log do Worker (wrangler tail).
      console.error('erro interno:', err && err.message);
      return withCors(errorResponse(500, 'INTERNAL', 'Erro interno.'), corsOrigin);
    }
  },
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function resolveCorsOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin');
  if (allowed.includes('*')) return '*';
  if (origin && allowed.includes(origin)) return origin;
  return null; // origem não permitida: resposta vai sem header CORS (o browser bloqueia)
}

function withCors(response, corsOrigin) {
  if (!corsOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', corsOrigin);
  if (corsOrigin !== '*') headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handleOptions(corsOrigin) {
  const headers = new Headers();
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'content-type, authorization'); // authorization: Bearer p/ sessão cross-origin
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

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
  };

  const handler = HANDLERS[routeKey];
  if (!handler) {
    // Caminho conhecido com método errado -> 405; caminho desconhecido -> 404.
    const knownPath = Object.keys(HANDLERS).some((k) => k.endsWith(' ' + path));
    if (knownPath) return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Método não permitido nesta rota.');
    return errorResponse(404, 'NOT_FOUND', 'Rota não encontrada.');
  }

  const limit = RATE_LIMITS[routeKey] || DEFAULT_RATE_LIMIT;
  const ip = request.headers.get('cf-connecting-ip');
  const rl = await checkRateLimit(env, routeKey, limit, ip);
  if (!rl.allowed) {
    // Contrato: retry_after no corpo E header Retry-After.
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

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

function handleHealth() {
  return jsonResponse({ ok: true, service: 'passaporte-fiscal', ruleset: RULESET_VERSION });
}

// ---------------------------------------------------------------------------
// GET /api/pubkey — chave pública Ed25519 derivada do secret
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /api/ruleset
// ---------------------------------------------------------------------------

function handleRuleset() {
  return jsonResponse({ ruleset: RULESET, ruleset_hash: RULESET_HASH });
}

// ---------------------------------------------------------------------------
// GET /api/closing/checklist — checklist de fechamento (diligência da contraparte)
// ---------------------------------------------------------------------------

function handleClosingChecklist() {
  return jsonResponse({ checklist: CLOSING_CHECKLIST, checklist_hash: CLOSING_CHECKLIST_HASH });
}

// ---------------------------------------------------------------------------
// GET /api/desagio?vn=&rating=&i=&T=
// Hardening: nada de fallback silencioso — entrada inválida é 400 com código claro.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/passaporte
// ---------------------------------------------------------------------------

async function handlePassaporte(request, env) {
  if (!hasSigningKey(env)) return noSigningKey();

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  if (!isNonEmptyString(body.holder_org_id)) {
    return errorResponse(400, 'INVALID_HOLDER_ORG_ID', 'Informe holder_org_id (identificador da organização titular).', 'holder_org_id');
  }
  if (
    typeof body.amount_cents !== 'number' ||
    !Number.isInteger(body.amount_cents) ||
    body.amount_cents <= 0 ||
    body.amount_cents > MAX_AMOUNT_CENTS
  ) {
    return errorResponse(400, 'INVALID_AMOUNT', 'Informe amount_cents como inteiro positivo (valor em centavos).', 'amount_cents');
  }
  if (!Array.isArray(body.documents)) {
    return errorResponse(400, 'INVALID_DOCUMENTS', 'Informe documents como array (pode ser vazio).', 'documents');
  }
  // Checklist de fechamento é opcional; se presente, deve ser array.
  if (body.closing !== undefined && !Array.isArray(body.closing)) {
    return errorResponse(400, 'INVALID_CLOSING', 'Informe closing como array de {kind, competencia?} (opcional).', 'closing');
  }

  const passaporte = await buildPassaporte(body);
  const assinado = await signPassaporte(env, passaporte);
  const pricing = computePricing(body.amount_cents, passaporte.rating.grade, DEFAULT_I, DEFAULT_T);

  return jsonResponse({ passaporte: assinado, pricing }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/verify — aceita {"passaporte":{...}}, {"passport":{...}} ou o objeto direto
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /api/lead — captura da landing (isca). Honeypot: campo "website".
// ---------------------------------------------------------------------------

async function handleLead(request, env) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  // Honeypot: bots preenchem "website". Fingimos sucesso SEM gravar nada.
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

// ---------------------------------------------------------------------------
// Autenticação v1 (portal do cliente) — users/sessions no D1 (0003_auth.sql).
// Senha: PBKDF2-SHA256 100k — teto do runtime (src/auth.js). Sessão: token opaco, gravado só
// como hash. O cookie Set-Cookie é anexado DEPOIS do jsonResponse (append) —
// o wrapper withCors copia os headers, então o cookie sobrevive.
// ---------------------------------------------------------------------------

function authUnavailable() {
  return errorResponse(503, 'AUTH_UNAVAILABLE', 'Autenticação temporariamente indisponível.');
}

// POST /api/auth/register — cadastro + sessão imediata (201).
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
    // createUser padroniza conflito de UNIQUE como { ok: false, code: 'EMAIL_TAKEN' }.
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

// Hash dummy fixo (formato válido) para equalizar o custo de PBKDF2 quando o
// e-mail não existe — anti-enumeração: usuário inexistente e senha errada
// têm a MESMA resposta e custo de hash parecido.
const DUMMY_PASSWORD_HASH =
  'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// POST /api/auth/login — credenciais → sessão (200).
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

// POST /api/auth/logout — invalida a sessão (se houver) e expira o cookie.
// Sem token → 200 { ok: true } mesmo assim (logout é idempotente).
async function handleAuthLogout(request, env) {
  if (!env.DB) return authUnavailable();

  const token = getSessionToken(request);
  if (token) await deleteSession(env, token);
  const res = jsonResponse({ ok: true });
  res.headers.append('Set-Cookie', clearSessionCookie());
  return res;
}

// GET /api/me — dados do usuário da sessão (cookie kilo_session ou Bearer).
async function handleMe(request, env) {
  if (!env.DB) return authUnavailable();

  const token = getSessionToken(request);
  const session = token ? await getUserBySession(env, token) : null;
  if (!session) {
    return errorResponse(401, 'AUTH_REQUIRED', 'Sessão ausente ou expirada.');
  }
  return jsonResponse({ user: session.user, session_expires_at: session.expires_at });
}
