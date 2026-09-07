-- 0002_rate_limits.sql — store do rate limit de janela fixa (ver src/ratelimit.js).
-- bucket = "<rota>|<ip>"; window_start = floor(unix_segundos / 60).
-- Aplicar com: wrangler d1 migrations apply kilo-passaporte --remote

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Limpeza periódica opcional (janelas antigas), ex. via agendamento ou manual:
--   DELETE FROM rate_limits WHERE window_start < (strftime('%s','now') / 60) - 10;
