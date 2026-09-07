// authdb.js — camada D1 da autenticação v1 (fina: só SQL + montagem de objetos).
//
// Tabelas: users / sessions (migration 0003_auth.sql). Regras:
//   - o token de sessão NUNCA é gravado puro: só o SHA-256 hex (token_hash);
//   - e-mail é gravado já normalizado (trim + lowercase) — feito no handler;
//   - datas em ISO 8601 UTC (new Date().toISOString()).
//
// Padrão de erro adotado: createUser NÃO lança em conflito de e-mail — retorna
// { ok: false, code: 'EMAIL_TAKEN' }. Demais erros de D1 sobem como exceção
// (o catch global do index.js responde 500 INTERNAL). Sucesso → { ok: true, user }.

import { sha256Hex, randomBase32 } from './canonical.js';
import { newSessionToken, SESSION_TTL_MS } from './auth.js';

// Insere o usuário e retorna { ok: true, user } com o usuário público (sem senha_hash).
// Conflito de UNIQUE no e-mail → { ok: false, code: 'EMAIL_TAKEN' }.
export async function createUser(env, { org_id, nome, email, senha_hash }) {
  const now = new Date().toISOString();
  const user = { id: 'usr_' + randomBase32(26), org_id, nome, email, created_at: now };
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, org_id, nome, email, senha_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(user.id, org_id, nome, email, senha_hash, now, now)
      .run();
  } catch (err) {
    if (err && /UNIQUE/i.test(String(err.message))) {
      return { ok: false, code: 'EMAIL_TAKEN' };
    }
    throw err;
  }
  return { ok: true, user };
}

// Busca por e-mail (já normalizado pelo caller). Retorna a row completa
// (inclui senha_hash, para a verificação de login) ou null.
export async function findUserByEmail(env, email) {
  const row = await env.DB.prepare(
    'SELECT id, org_id, nome, email, senha_hash, created_at FROM users WHERE email = ?'
  )
    .bind(email)
    .first();
  return row || null;
}

// Cria sessão para o usuário: gera token opaco, grava apenas sha256(token),
// com IP/user-agent para auditoria. Aproveita para limpeza oportunista de
// sessões expiradas (DELETE WHERE expires_at < agora) — sem agendamento.
// Retorna { token, expires_at } (o token puro existe apenas aqui e no cliente).
export async function createSession(env, userId, request) {
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      tokenHash,
      userId,
      now,
      expires,
      request.headers.get('cf-connecting-ip') || null,
      request.headers.get('user-agent') || null
    )
    .run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return { token, expires_at: expires };
}

// Resolve o usuário dono do token. Ausente ou expirado → null.
// Senão { user: {id, org_id, nome, email}, expires_at }.
export async function getUserBySession(env, token) {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at AS expires_at, u.id AS id, u.org_id AS org_id, u.nome AS nome, u.email AS email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  // ISO 8601 UTC compara lexicograficamente.
  if (row.expires_at <= new Date().toISOString()) return null;
  return {
    user: { id: row.id, org_id: row.org_id, nome: row.nome, email: row.email },
    expires_at: row.expires_at,
  };
}

// Remove a sessão (logout). Token desconhecido → no-op.
export async function deleteSession(env, token) {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
