-- 0004_registro.sql — Bolsa de Registro (MVP anti-dupla-venda).
-- Ciclo de vida do título: projeção (registry_titles) + log append-only
-- (registry_events). Aplicar com: wrangler d1 migrations apply kilo-passaporte --remote
--
-- IMPORTANTE (mote): o registro Kilo impede fraude INFORMACIONAL (vender o
-- mesmo dossiê a N compradores). A transferência FISCAL continua sendo da
-- SEFAZ (CAT 42) — o registro aponta para ela, não a substitui.

CREATE TABLE IF NOT EXISTS registry_titles (
  passport_id TEXT PRIMARY KEY,     -- psp_<hex> do passaporte registrado
  input_hash TEXT NOT NULL,         -- hash do dossiê (sem prefixo sha256:)
  holder_org_id TEXT NOT NULL,      -- titular original (emissor)
  current_owner TEXT NOT NULL,      -- dono atual (muda em 'transferred')
  status TEXT NOT NULL,             -- registered|listed|reserved|transferred|canceled
  rating TEXT,                      -- A|B|C no momento do registro
  amount_cents INTEGER,
  jurisdiction TEXT,
  reference_from TEXT,
  reference_to TEXT,
  created_at TEXT NOT NULL,         -- ISO 8601 UTC
  updated_at TEXT NOT NULL
);
-- Anti-dupla-listagem: o mesmo dossiê (input_hash) do mesmo titular não entra 2x.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_titles_dossier
  ON registry_titles(input_hash, holder_org_id);
CREATE INDEX IF NOT EXISTS idx_registry_titles_status ON registry_titles(status);

CREATE TABLE IF NOT EXISTS registry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  passport_id TEXT NOT NULL REFERENCES registry_titles(passport_id),
  event TEXT NOT NULL,              -- registered|listed|unlisted|reserved|transferred|canceled
  actor TEXT NOT NULL,              -- quem disparou (org id; comprador no 'reserved')
  to_owner TEXT,                    -- novo dono (obrigatório em 'transferred')
  note TEXT,
  created_at TEXT NOT NULL          -- ISO 8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_registry_events_pid ON registry_events(passport_id);
