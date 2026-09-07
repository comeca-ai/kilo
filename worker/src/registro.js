// registro.js — Bolsa de Registro (MVP anti-dupla-venda).
//
// Rotas:
//   POST /api/registro           — registra um título (passaporte assinado)
//   GET  /api/registro?status=   — mural público (projeção, sem eventos)
//   GET  /api/registro/{id}      — situação + histórico do título ("consulte antes de comprar")
//   POST /api/registro/{id}      — evento de ciclo de vida {event, actor, to_owner?, note?}
//
// Regras:
//   - registro exige assinatura Ed25519 VÁLIDA do passaporte (verifyPassaporte);
//   - o mesmo dossiê (input_hash) do mesmo titular não registra 2x
//     (UNIQUE(input_hash, holder_org_id) → 409 TITLE_ALREADY_REGISTERED);
//   - transições seguem a máquina TRANSITIONS (abaixo) — fora dela: 409;
//   - list/unlist/transfer/cancel exigem actor == current_owner; reserve exige
//     actor != current_owner (o comprador se identifica no evento);
//   - o log registry_events é append-only: nada aqui faz UPDATE/DELETE nele.
//
// Mote: "registro, não garanto transferência fiscal" — a transferência fiscal
// é da SEFAZ (CAT 42). O registro torna pública a situação do título.

import { jsonResponse, errorResponse, parseJsonBody, isNonEmptyString } from './validate.js';
import { extractPassaporte, verifyPassaporte, hasSigningKey } from './passport.js';

const STATUS = Object.freeze(['registered', 'listed', 'reserved', 'transferred', 'canceled']);

// evento → { from: status que aceitam o evento, next: status resultante,
//            role: 'owner' (actor deve ser o dono) | 'buyer' (actor ≠ dono),
//            needsToOwner: exige to_owner }
const TRANSITIONS = Object.freeze({
  listed:      { from: ['registered', 'transferred'], next: 'listed',      role: 'owner' },
  unlisted:    { from: ['listed'],                    next: 'registered',  role: 'owner' },
  reserved:    { from: ['listed'],                    next: 'reserved',    role: 'buyer' },
  transferred: { from: ['listed', 'reserved'],        next: 'transferred', role: 'owner', needsToOwner: true },
  canceled:    { from: ['registered', 'listed', 'reserved'], next: 'canceled', role: 'owner' },
});

function dbUnavailable() {
  return errorResponse(503, 'REGISTRY_UNAVAILABLE', 'Registro temporariamente indisponível.');
}

function rowToTitulo(r) {
  return {
    passport_id: r.passport_id,
    status: r.status,
    current_owner: r.current_owner,
    holder_org_id: r.holder_org_id,
    rating: r.rating,
    amount_cents: r.amount_cents,
    jurisdiction: r.jurisdiction,
    reference_period: { from: r.reference_from, to: r.reference_to },
    input_hash: 'sha256:' + r.input_hash,
    registered_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function loadTitle(env, passportId) {
  return env.DB.prepare('SELECT * FROM registry_titles WHERE passport_id = ?')
    .bind(passportId)
    .first();
}

// --- POST /api/registro — registra título a partir do passaporte assinado ---
export async function handleRegistroRegister(request, env) {
  if (!env.DB) return dbUnavailable();
  if (!hasSigningKey(env)) {
    return errorResponse(503, 'NO_SIGNING_KEY', 'Chave de assinatura não configurada.');
  }
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const passaporte = extractPassaporte(parsed.value);
  if (!passaporte) {
    return errorResponse(400, 'INVALID_PASSAPORTE', 'Envie o passaporte em {"passaporte": {...}} (ou o objeto direto).', 'passaporte');
  }
  if (!isNonEmptyString(passaporte.passport_id)) {
    return errorResponse(400, 'INVALID_PASSAPORTE', 'Passaporte sem passport_id.', 'passaporte');
  }
  const { valid } = await verifyPassaporte(env, passaporte);
  if (!valid) {
    return errorResponse(400, 'INVALID_SIGNATURE', 'Assinatura do passaporte não confere — só se registra título autêntico.', 'passaporte');
  }
  const inputHash = String(passaporte.input_hash || '').replace(/^sha256:/, '');
  const holder = passaporte.holder_org_id;
  if (!isNonEmptyString(inputHash) || !isNonEmptyString(holder)) {
    return errorResponse(400, 'INVALID_PASSAPORTE', 'Passaporte sem input_hash/holder_org_id.', 'passaporte');
  }

  // Dedupe: mesmo dossiê + mesmo titular → aponta o registro existente.
  const dup = await env.DB.prepare(
    'SELECT passport_id FROM registry_titles WHERE input_hash = ? AND holder_org_id = ?'
  )
    .bind(inputHash, holder)
    .first();
  if (dup) {
    return jsonResponse(
      {
        error: {
          code: 'TITLE_ALREADY_REGISTERED',
          message: 'Este dossiê já está registrado para este titular — consulte a situação antes de negociar.',
          passport_id: dup.passport_id,
        },
      },
      409
    );
  }

  const now = new Date().toISOString();
  const rating = passaporte.rating && passaporte.rating.grade ? String(passaporte.rating.grade) : null;
  const ref = passaporte.reference_period || {};
  const tituloRow = {
    passport_id: passaporte.passport_id,
    input_hash: inputHash,
    holder_org_id: holder,
    current_owner: holder,
    status: 'registered',
    rating,
    amount_cents: typeof passaporte.amount_cents === 'number' ? passaporte.amount_cents : null,
    jurisdiction: passaporte.jurisdiction || null,
    reference_from: ref.from || null,
    reference_to: ref.to || null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO registry_titles
         (passport_id, input_hash, holder_org_id, current_owner, status, rating,
          amount_cents, jurisdiction, reference_from, reference_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        tituloRow.passport_id, tituloRow.input_hash, tituloRow.holder_org_id,
        tituloRow.current_owner, tituloRow.status, tituloRow.rating,
        tituloRow.amount_cents, tituloRow.jurisdiction,
        tituloRow.reference_from, tituloRow.reference_to, now, now
      )
      .run();
    await env.DB.prepare(
      'INSERT INTO registry_events (passport_id, event, actor, to_owner, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(tituloRow.passport_id, 'registered', holder, null, null, now)
      .run();
  } catch (err) {
    if (err && /UNIQUE/i.test(String(err.message))) {
      return errorResponse(409, 'TITLE_ALREADY_REGISTERED', 'Este passaporte/dossiê já está registrado.');
    }
    console.error('falha ao registrar título:', err && err.message);
    return dbUnavailable();
  }

  const titulo = await loadTitle(env, tituloRow.passport_id);
  return jsonResponse(
    {
      titulo: rowToTitulo(titulo),
      evento: { event: 'registered', actor: holder, at: now },
      disclaimer: 'Registro Kilo — não é transferência fiscal. A transferência do crédito é da SEFAZ (CAT 42).',
    },
    201
  );
}

// --- GET /api/registro?status=listed — mural público ---
export async function handleRegistroList(request, env, url) {
  if (!env.DB) return dbUnavailable();
  const status = url.searchParams.get('status');
  let rows;
  if (status) {
    if (!STATUS.includes(status)) {
      return errorResponse(400, 'INVALID_STATUS', 'Status inválido — use ' + STATUS.join('|') + '.', 'status');
    }
    rows = await env.DB.prepare(
      'SELECT * FROM registry_titles WHERE status = ? ORDER BY updated_at DESC LIMIT 100'
    )
      .bind(status)
      .all();
  } else {
    rows = await env.DB.prepare('SELECT * FROM registry_titles ORDER BY updated_at DESC LIMIT 100').all();
  }
  const titulos = (rows.results || []).map(rowToTitulo);
  return jsonResponse({ titulos, count: titulos.length });
}

// --- GET /api/registro/{id} — situação + histórico ("consulte antes de comprar") ---
export async function handleRegistroGet(request, env, passportId) {
  if (!env.DB) return dbUnavailable();
  if (!isNonEmptyString(passportId)) {
    return errorResponse(400, 'INVALID_PASSPORT_ID', 'Informe o passport_id na rota.', 'passport_id');
  }
  const titulo = await loadTitle(env, passportId);
  if (!titulo) {
    return errorResponse(404, 'TITLE_NOT_FOUND', 'Título não registrado na bolsa Kilo.');
  }
  const ev = await env.DB.prepare(
    'SELECT event, actor, to_owner, note, created_at FROM registry_events WHERE passport_id = ? ORDER BY id ASC'
  )
    .bind(passportId)
    .all();
  return jsonResponse({
    titulo: rowToTitulo(titulo),
    eventos: (ev.results || []).map((e) => ({
      event: e.event,
      actor: e.actor,
      to_owner: e.to_owner,
      note: e.note,
      at: e.created_at,
    })),
    disclaimer: 'Registro Kilo — não é transferência fiscal. A transferência do crédito é da SEFAZ (CAT 42).',
  });
}

// --- POST /api/registro/{id} — evento de ciclo de vida ---
export async function handleRegistroEvent(request, env, passportId) {
  if (!env.DB) return dbUnavailable();
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  const event = body.event;
  const spec = TRANSITIONS[event];
  if (!spec) {
    return errorResponse(400, 'INVALID_EVENT', 'Evento inválido — use ' + Object.keys(TRANSITIONS).join('|') + '.', 'event');
  }
  if (!isNonEmptyString(body.actor)) {
    return errorResponse(400, 'INVALID_ACTOR', 'Informe actor (org id de quem dispara o evento).', 'actor');
  }
  const actor = body.actor.trim();
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return errorResponse(400, 'INVALID_NOTE', 'Campo note deve ser texto.', 'note');
  }

  const titulo = await loadTitle(env, passportId);
  if (!titulo) {
    return errorResponse(404, 'TITLE_NOT_FOUND', 'Título não registrado na bolsa Kilo.');
  }
  if (!spec.from.includes(titulo.status)) {
    return jsonResponse(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: `Não dá para '${event}' um título em '${titulo.status}'.`,
          status_atual: titulo.status,
          evento: event,
          aceita_em: spec.from,
        },
      },
      409
    );
  }
  if (spec.role === 'owner' && actor !== titulo.current_owner) {
    return errorResponse(403, 'NOT_TITLE_OWNER', 'Só o dono atual do título dispara este evento.', 'actor');
  }
  if (spec.role === 'buyer' && actor === titulo.current_owner) {
    return errorResponse(400, 'INVALID_ACTOR', 'Reserva é feita pelo comprador, não pelo dono do título.', 'actor');
  }
  let toOwner = null;
  if (spec.needsToOwner) {
    if (!isNonEmptyString(body.to_owner)) {
      return errorResponse(400, 'INVALID_TO_OWNER', 'Transferência exige to_owner (org id do novo dono).', 'to_owner');
    }
    toOwner = body.to_owner.trim();
    if (toOwner === titulo.current_owner) {
      return errorResponse(400, 'INVALID_TO_OWNER', 'to_owner deve ser diferente do dono atual.', 'to_owner');
    }
  } else if (isNonEmptyString(body.to_owner)) {
    toOwner = body.to_owner.trim();
  }

  const now = new Date().toISOString();
  const newOwner = event === 'transferred' ? toOwner : titulo.current_owner;
  try {
    await env.DB.prepare(
      'INSERT INTO registry_events (passport_id, event, actor, to_owner, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(passportId, event, actor, toOwner, body.note || null, now)
      .run();
    await env.DB.prepare(
      'UPDATE registry_titles SET status = ?, current_owner = ?, updated_at = ? WHERE passport_id = ?'
    )
      .bind(spec.next, newOwner, now, passportId)
      .run();
  } catch (err) {
    console.error('falha ao gravar evento de registro:', err && err.message);
    return dbUnavailable();
  }

  const atualizado = await loadTitle(env, passportId);
  return jsonResponse({
    titulo: rowToTitulo(atualizado),
    evento: { event, actor, to_owner: toOwner, at: now },
    disclaimer: 'Registro Kilo — não é transferência fiscal. A transferência do crédito é da SEFAZ (CAT 42).',
  });
}
