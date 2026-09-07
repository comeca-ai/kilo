/**
 * passaporte-v2.test.mjs — emissão nasce do dossiê do motor.
 *
 * Cobre o que a v1 não tinha:
 *   - buildPassaporteFromDossier com golden A e C (C não vira A)
 *   - POST /api/passaporte golden A/B/C
 *   - body v1 → 400 PASSPORT_V1_RETIRED
 *   - output_hash mentiroso → 409 DOSSIER_MISMATCH
 *   - corpo > 2 MB → 413 PAYLOAD_TOO_LARGE (passaporte e scan)
 *   - /api/verify de passaporte v1 já emitido
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { sha256Hex } from '../motor/canonical.js';
import { executar } from '../motor/engine.js';
import { RULESET } from '../rulesets/br-sp-cat42.v2026.09.js';
import {
  buildPassaporte,
  buildPassaporteFromDossier,
  signPassaporte,
  verifyPassaporte,
} from '../src/passport.js';
import worker from '../src/index.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(RAIZ, 'fixtures');
const casosJson = JSON.parse(await readFile(path.join(FIXTURES, 'casos.json'), 'utf8'));

async function carregaDocumentos(caso) {
  const docs = [];
  for (const d of caso.documents) {
    const bytes = await readFile(path.join(FIXTURES, d.arquivo));
    const doc = {
      kind: d.kind,
      name: path.basename(d.arquivo),
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
    if (d.kind === 'nfe_xml' || d.kind === 'efd_icms_ipi') doc.text = bytes.toString('utf8');
    docs.push(doc);
  }
  return docs;
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

async function signingEnv() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { SIGNING_KEY_JWK: JSON.stringify(jwk) };
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

test('passaporte v2 nasce do dossiê: rating/findings/output_hash do motor (caso A)', async () => {
  const casoA = casosJson.casos.find((c) => c.id === 'A');
  const { dossier } = await executar({
    documents: await carregaDocumentos(casoA),
    ruleset: RULESET,
    params: casosJson.params_comuns,
  });
  const p = await buildPassaporteFromDossier({
    holder_org_id: 'cnpj_11222333000181',
    reference_period: casosJson.params_comuns.reference_period,
    amount_cents: casosJson.params_comuns.amount_cents,
    dossier,
  });
  assert.equal(p.version, 2);
  assert.equal(p.rating.grade, 'A');
  assert.equal(p.rating.g, 0.01);
  assert.equal(p.completeness, 1);
  assert.deepEqual(p.findings, []);
  assert.equal(p.output_hash, 'sha256:' + dossier.output_hash);
  assert.equal(p.motor.output_hash, dossier.output_hash);
  assert.equal(p.status_claim, 'DOCUMENTED_FOR_REVIEW');
  assert.equal(
    p.ruleset_hash,
    'sha256:49878474f494a1545a3c3e94a04f4b031e9057d25c5e734fd9fe294e98f383d7'
  );
});

test('passaporte v2 caso C: grade C e os 4 findings do motor — não inventa A', async () => {
  const casoC = casosJson.casos.find((c) => c.id === 'C');
  const { dossier } = await executar({
    documents: await carregaDocumentos(casoC),
    ruleset: RULESET,
    params: casosJson.params_comuns,
  });
  const p = await buildPassaporteFromDossier({
    holder_org_id: 'cnpj_11222333000181',
    amount_cents: casosJson.params_comuns.amount_cents,
    reference_period: casosJson.params_comuns.reference_period,
    dossier,
  });
  assert.equal(p.rating.grade, 'C');
  assert.equal(p.findings.length, 4);
  assert.deepEqual(p.findings.map((f) => f.check), casoC.esperado.checks);
});

test('POST /api/passaporte v1 (só kinds) → 400 PASSPORT_V1_RETIRED', async () => {
  const env = await signingEnv();
  const res = await callApi(env, 'POST', '/api/passaporte', {
    body: {
      holder_org_id: 'cnpj_11222333000181',
      amount_cents: 135000,
      documents: [
        { kind: 'efd_icms_ipi' },
        { kind: 'nfe_xml' },
        { kind: 'apuracao' },
        { kind: 'livro_registro' },
      ],
    },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'PASSPORT_V1_RETIRED');
});

for (const caso of casosJson.casos) {
  test(`POST /api/passaporte v2 golden ${caso.id} → 201 grade ${caso.esperado.rating}`, async () => {
    const env = await signingEnv();
    const res = await callApi(env, 'POST', '/api/passaporte', { body: await bodyGolden(caso.id) });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.passaporte.version, 2);
    assert.equal(data.passaporte.rating.grade, caso.esperado.rating);
    assert.equal(data.passaporte.completeness, caso.esperado.completude);
    assert.equal(data.passaporte.findings.length, caso.esperado.qtd_findings);
    assert.deepEqual(data.passaporte.findings.map((f) => f.check), caso.esperado.checks);
    assert.equal(data.passaporte.status_claim, 'DOCUMENTED_FOR_REVIEW');
    assert.equal(data.passaporte.output_hash, 'sha256:' + data.dossier.output_hash);
    assert.equal(data.pricing.inputs.grade, caso.esperado.rating);
    const ver = await callApi(env, 'POST', '/api/verify', { body: { passaporte: data.passaporte } });
    assert.equal(ver.status, 200);
    assert.equal((await ver.json()).valid, true);
  });
}

test('POST /api/passaporte output_hash divergente → 409 DOSSIER_MISMATCH', async () => {
  const env = await signingEnv();
  const body = await bodyGolden('A');
  body.output_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const res = await callApi(env, 'POST', '/api/passaporte', { body });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'DOSSIER_MISMATCH');
});

test('POST /api/passaporte corpo > 2 MB → 413 PAYLOAD_TOO_LARGE', async () => {
  const env = await signingEnv();
  const res = await worker.fetch(
    new Request('https://teste.local/api/passaporte', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
      body: JSON.stringify({
        holder_org_id: 'cnpj_11222333000181',
        amount_cents: 135000,
        nfe_xml: '<nfe/>',
      }),
    }),
    env,
    {}
  );
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('POST /api/scan corpo > 2 MB → 413 PAYLOAD_TOO_LARGE (mesmo teto)', async () => {
  const res = await worker.fetch(
    new Request('https://teste.local/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
      body: JSON.stringify({ nfe_xml: '<nfe/>' }),
    }),
    {},
    {}
  );
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('POST /api/verify aceita passaporte v1 já emitido', async () => {
  const env = await signingEnv();
  const v1 = await buildPassaporte({
    holder_org_id: 'cnpj_11222333000181',
    amount_cents: 135000,
    reference_period: { from: '2026-08-01', to: '2026-08-31' },
    documents: [
      { kind: 'efd_icms_ipi' },
      { kind: 'nfe_xml' },
      { kind: 'apuracao' },
      { kind: 'livro_registro' },
    ],
  });
  assert.equal(v1.version, 1);
  const assinado = await signPassaporte(env, v1);
  assert.equal((await verifyPassaporte(env, assinado)).valid, true);
  const res = await callApi(env, 'POST', '/api/verify', { body: { passaporte: assinado } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).valid, true);
});
