-- 0003_auth.sql — autenticação v1: usuários e sessões (portal do cliente).
-- Aplicar com: wrangler d1 migrations apply kilo-passaporte --remote

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- usr_<base32>
  org_id TEXT NOT NULL,             -- holder_org_id usado nos passaportes
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,       -- normalizado: trim + lowercase
  senha_hash TEXT NOT NULL,         -- pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>
  created_at TEXT NOT NULL,         -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,      -- sha256 hex do token (o token puro NUNCA é gravado)
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- ISO; sessão de 7 dias
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
