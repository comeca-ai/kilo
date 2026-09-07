-- 0001_leads.sql — captura de leads da landing (POST /api/lead).
-- Aplicar com: wrangler d1 migrations apply kilo-passaporte --remote

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  empresa TEXT,
  valor_credito REAL,
  simulacao TEXT,           -- JSON serializado (texto), quando o lead veio de uma simulação
  ip TEXT,                  -- cf-connecting-ip, para auditoria/anti-abuso
  user_agent TEXT,
  created_at TEXT NOT NULL  -- ISO 8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
