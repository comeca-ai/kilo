/**
 * registro.test.mjs — Bolsa de Registro (MVP anti-dupla-venda).
 *
 * Cobre:
 *   - registrar título com assinatura válida → 201 + evento 'registered'
 *   - dedupe (mesmo dossiê + titular) → 409 TITLE_ALREADY_REGISTERED
 *   - assinatura adulterada → 400 INVALID_SIGNATURE
 *   - consulta GET /api/registro/{id} (200) e desconhecido (404)
 *   - máquina de estados: list → reserve → transfer (dono troca)
 *   - transições/ator inválidos → 409 INVALID_TRANSITION, 403 NOT_TITLE_OWNER,
 *     400 INVALID_ACTOR / INVALID_TO_OWNER / INVALID_EVENT
 *   - mural GET /api/registro?status=listed
 *
 * mockD1(): arrays em memória especializados por substring do SQL de
 * src/registro.js — SQL fora do conjunto lança erro (o rate limit cai no
 * fallback em memória, como nos demais testes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { sha256Hex } from '../motor/canonical.js';
import worker from '../src/index.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(RAIZ, 'fixtures');
const casosJson = JSON.parse(await readFile(path.join(FIXTURES, 'casos.json'), 'utf8'));

function mockD1() {
  const titles = []; // linhas registry_titles
  const events = []; // linhas registry_events
  let seq = 0;

  function run(sql, args) {
    if (sql.startsWith('INSERT INTO registry_titles')) {
      if (titles.some((t) => t.passport_id === args[0])) {
        throw new Error('UNIQUE constraint failed: registry_titles.passport_id');
      }
      if (titles.some((t) => t.input_hash === args[1] && t.holder_org_id === args[2])) {
        throw new Error('UNIQUE constraint failed: idx_registry_titles_dossier');
      }
      titles.push({
        passport_id: args[0], input_hash: args[1], holder_org_id: args[2],
        current_owner: args[3], status: args[4], rating: args[5],
        amount_cents: args[6], jurisdiction: args[7],
        reference_from: args[8], reference_to: args[9],
        created_at: args[10], updated_at: args[11],
      });
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT INTO registry_events')) {
      seq += 1;
      events.push({
        id: seq, passport_id: args[0], event: args[1], actor: args[2],
        to_owner: args[3], note: args[4], created_at: args[5],
      });
      return { changes: 1 };
    }
    if (sql.startsWith('UPDATE registry_titles SET status')) {
      const t = titles.find((x) => x.passport_id === args[3]);
      if (!t) return { changes: 0 };
      t.status = args[0];
      t.current_owner = args[1];
      t.updated_at = args[2];
      return { changes: 1 };
    }
    throw new Error('mockD1: SQL não suportado (run): ' + sql);
  }

  function first(sql, args) {
    if (sql.includes('FROM registry_titles') && sql.includes('WHERE passport_id')) {
      return titles.find((t) => t.passport_id === args[0]) || null;
    }
    if (sql.includes('FROM registry_titles') && sql.includes('input_hash = ?')) {
      const t = titles.find((x) => x.input_hash === args[0] && x.holder_org_id === args[1]);
      return t ? { passport_id: t.passport_id } : null;
    }
    throw new Error('mockD1: SQL não suportado (first): ' + sql);
  }

  function all(sql, args) {
    if (sql.includes('FROM registry_titles') && sql.includes('WHERE status = ?')) {
      return { results: titles.filter((t) => t.status === args[0]) };
    }
    if (sql.includes('FROM registry_titles')) {
      return { results: [...titles] };
    }
    if (sql.includes('FROM registry_events') && sql.includes('WHERE passport_id')) {
      return { results: events.filter((e) => e.passport_id === args[0]) };
    }
    throw new Error('mockD1: SQL não suportado (all): ' + sql);
  }

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => run(sql, args),
            first: async () => first(sql, args),
            all: async () => all(sql, args),
          };
        },
      };
    },
  };
}

async function signingEnv() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { SIGNING_KEY_JWK: JSON.stringify(jwk), DB: mockD1() };
}

function callApi(env, method, pathName, { body, headers = {} } = {}) {
  return worker.fetch(
    new Request('https://teste.local' + pathName, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
    {}
  );
}

async function bodyGolden(id) {
  const caso = casosJson.casos.find((c) => c.id === id);
  const nfe_xml = [];
  const supporting_docs = [];
  let efd_text;
  for (const d of caso.documents) {
    const bytes = await readFile(path.join(FIXTURES, d.arquivo));
    if (d.kind === 'nfe_xml') nfe_xml.push(bytes.toString('utf8'));
    else if (d.kind === 'efd_icms_ipi') efd_text = bytes.toString('utf8');
    else {
      supporting_docs.push({
        kind: d.kind,
        name: path.basename(d.arquivo),
        sha256: await sha256Hex(bytes),
        bytes: bytes.length,
      });
    }
  }
  return {
    holder_org_id: 'cnpj_11222333000181',
    ...casosJson.params_comuns,
    nfe_xml,
    efd_text,
    supporting_docs,
  };
}

// Emite 1 passaporte real (golden A) e devolve { env, passaporte }.
async function setupTitulo() {
  const env = await signingEnv();
  const body = await bodyGolden('A');
  const r = await callApi(env, 'POST', '/api/passaporte', { body });
  assert.equal(r.status, 201);
  const j = await r.json();
  return { env, passaporte: j.passaporte };
}

test('registrar título válido → 201, status registered, evento registrado', async () => {
  const { env, passaporte } = await setupTitulo();
  const r = await callApi(env, 'POST', '/api/registro', { body: { passaporte } });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.titulo.passport_id, passaporte.passport_id);
  assert.equal(j.titulo.status, 'registered');
  assert.equal(j.titulo.current_owner, 'cnpj_11222333000181');
  assert.equal(j.titulo.rating, 'A');
  assert.equal(j.evento.event, 'registered');
  assert.ok(j.disclaimer.includes('SEFAZ'));
});

test('dedupe: mesmo dossiê + titular → 409 TITLE_ALREADY_REGISTERED', async () => {
  const { env, passaporte } = await setupTitulo();
  const r1 = await callApi(env, 'POST', '/api/registro', { body: { passaporte } });
  assert.equal(r1.status, 201);
  const r2 = await callApi(env, 'POST', '/api/registro', { body: { passaporte } });
  assert.equal(r2.status, 409);
  const j = await r2.json();
  assert.equal(j.error.code, 'TITLE_ALREADY_REGISTERED');
  assert.equal(j.error.passport_id, passaporte.passport_id);
});

test('assinatura adulterada → 400 INVALID_SIGNATURE', async () => {
  const { env, passaporte } = await setupTitulo();
  const falso = { ...passaporte, amount_cents: passaporte.amount_cents + 100 };
  const r = await callApi(env, 'POST', '/api/registro', { body: { passaporte: falso } });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.code, 'INVALID_SIGNATURE');
});

test('consulta pública: titulo + histórico; desconhecido → 404', async () => {
  const { env, passaporte } = await setupTitulo();
  await callApi(env, 'POST', '/api/registro', { body: { passaporte } });
  const r = await callApi(env, 'GET', '/api/registro/' + passaporte.passport_id);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.titulo.status, 'registered');
  assert.equal(j.eventos.length, 1);
  assert.equal(j.eventos[0].event, 'registered');
  const r404 = await callApi(env, 'GET', '/api/registro/psp_inexistente');
  assert.equal(r404.status, 404);
  const j404 = await r404.json();
  assert.equal(j404.error.code, 'TITLE_NOT_FOUND');
});

test('ciclo completo: list → reserve → transfer (dono troca, histórico acumula)', async () => {
  const { env, passaporte } = await setupTitulo();
  const pid = passaporte.passport_id;
  const dono = 'cnpj_11222333000181';
  await callApi(env, 'POST', '/api/registro', { body: { passaporte } });

  let r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'listed', actor: dono } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).titulo.status, 'listed');

  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'reserved', actor: 'cnpj_comprador_1' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).titulo.status, 'reserved');

  r = await callApi(env, 'POST', '/api/registro/' + pid, {
    body: { event: 'transferred', actor: dono, to_owner: 'cnpj_comprador_1' },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.titulo.status, 'transferred');
  assert.equal(j.titulo.current_owner, 'cnpj_comprador_1');

  // novo dono pode listar de novo
  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'listed', actor: 'cnpj_comprador_1' } });
  assert.equal(r.status, 200);

  const consulta = await (await callApi(env, 'GET', '/api/registro/' + pid)).json();
  assert.deepEqual(
    consulta.eventos.map((e) => e.event),
    ['registered', 'listed', 'reserved', 'transferred', 'listed']
  );
});

test('máquina de estados e atores: erros corretos', async () => {
  const { env, passaporte } = await setupTitulo();
  const pid = passaporte.passport_id;
  const dono = 'cnpj_11222333000181';
  await callApi(env, 'POST', '/api/registro', { body: { passaporte } });

  // reserve em 'registered' → 409
  let r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'reserved', actor: 'cnpj_x' } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'INVALID_TRANSITION');

  // list por não-dono → 403
  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'listed', actor: 'cnpj_intruso' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'NOT_TITLE_OWNER');

  await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'listed', actor: dono } });

  // reserve pelo próprio dono → 400
  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'reserved', actor: dono } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'INVALID_ACTOR');

  // transfer sem to_owner → 400
  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'transferred', actor: dono } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'INVALID_TO_OWNER');

  // evento inexistente → 400
  r = await callApi(env, 'POST', '/api/registro/' + pid, { body: { event: 'vendido', actor: dono } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'INVALID_EVENT');
});

test('mural: GET /api/registro?status=listed lista o título; status inválido → 400', async () => {
  const { env, passaporte } = await setupTitulo();
  const dono = 'cnpj_11222333000181';
  await callApi(env, 'POST', '/api/registro', { body: { passaporte } });
  await callApi(env, 'POST', '/api/registro/' + passaporte.passport_id, { body: { event: 'listed', actor: dono } });

  const r = await callApi(env, 'GET', '/api/registro?status=listed');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.count, 1);
  assert.equal(j.titulos[0].passport_id, passaporte.passport_id);

  const rbad = await callApi(env, 'GET', '/api/registro?status=vendido');
  assert.equal(rbad.status, 400);
  assert.equal((await rbad.json()).error.code, 'INVALID_STATUS');
});
