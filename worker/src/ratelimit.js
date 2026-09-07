// ratelimit.js — janela fixa por IP, com D1 como store e fallback em memória.
//
// Store primário: tabela D1 rate_limits(bucket TEXT, window_start INTEGER, count INTEGER,
// PRIMARY KEY(bucket, window_start)) — ver migrations/0002_rate_limits.sql.
// A janela é fixa de 60s: window_start = floor(unix_seg / 60).
//
 // v2: D1 incr usa RETURNING (1 round-trip) em vez de INSERT + SELECT.
//
// Fallback em memória (quando o binding D1 não existe, ex.: dev local sem --d1):
// Map por isolate. É APROXIMADO: cada isolate tem seu próprio contador, então o limite
// efetivo pode ser até N× o configurado (N = nº de isolates ativos). Serve para dev e
// para degradação graciosa, não como garantia global.

const WINDOW_SECONDS = 60;

// Fallback em memória, vive no escopo do módulo (por isolate).
const memBuckets = new Map(); // key: `${bucket}:${windowStart}` -> count

function memIncr(bucket, windowStart) {
  // Limpeza oportunista de janelas antigas para o Map não crescer sem limite.
  if (memBuckets.size > 5000) {
    for (const key of memBuckets.keys()) {
      const ws = Number(key.slice(key.lastIndexOf(':') + 1));
      if (ws < windowStart - 1) memBuckets.delete(key);
    }
  }
  const key = bucket + ':' + windowStart;
  const count = (memBuckets.get(key) || 0) + 1;
  memBuckets.set(key, count);
  return count;
}

async function d1Incr(db, bucket, windowStart) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(bucket, windowStart)
    .first();
  return row && typeof row.count === 'number' ? row.count : 1;
}

// Verifica o limite. Retorna { allowed: true } ou { allowed: false, retryAfter }.
// Em caso de FALHA do D1 (tabela ausente, erro transitório), degrada para o fallback
 // em memória em vez de derrubar a requisição — disponibilidade > precisão do limite.
export async function checkRateLimit(env, routeKey, limitPerMinute, ip) {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const bucket = routeKey + '|' + (ip || 'unknown');

  let count;
  if (env.DB) {
    try {
      count = await d1Incr(env.DB, bucket, windowStart);
    } catch {
      count = memIncr(bucket, windowStart);
    }
  } else {
    count = memIncr(bucket, windowStart);
  }

  if (count <= limitPerMinute) return { allowed: true };

  const nowSec = Math.floor(Date.now() / 1000);
  const retryAfter = (windowStart + 1) * WINDOW_SECONDS - nowSec;
  return { allowed: false, retryAfter: Math.max(1, retryAfter) };
}
