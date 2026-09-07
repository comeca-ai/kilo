/**
 * run.test.mjs — suíte do motor de regras (node:test, Node 18+).
 *
 * Executar:  node --test test/run.test.mjs   (na raiz de track3-intake-motor)
 *
 * Cobre:
 *   - canonicalStringify (ordenação de chaves, aninhamento)
 *   - sha256Hex com vetor conhecido ("abc")
 *   - parseNFe (campos, nfeProc e NFe pura, erro em XML malformado)
 *   - parseEFD (período, contagem/chaves C100, apuração E110, erro sem 0000)
 *   - cada check isolado com fixture mínima inline
 *   - engine nos 3 casos golden (fixtures/casos.json) com expectativa exata
 *   - REPRODUTIBILIDADE: 2 execuções → output_hash idêntico
 *
 * Todos os dados são SINTÉTICOS (ver fixtures/casos.json).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { canonicalStringify, sha256Hex } from '../motor/canonical.js';
import { parseNFe } from '../motor/nfe.js';
import { parseEFD } from '../motor/efd.js';
import {
  docComplete,
  periodoCoerente,
  nfeAusenteEfd,
  chaveDuplicada,
  valorPositivo,
  iePresente,
  executarChecks,
} from '../motor/checks.js';
import { ratingV1 } from '../motor/rating.js';
import { buildManifest, buildOutputHash } from '../motor/manifest.js';
import { executar } from '../motor/engine.js';
import { RULESET } from '../rulesets/br-sp-cat42.v2026.09.js';
import { RULESET_HASH } from '../src/ruleset.js';
import {
  CLOSING_CHECKLIST,
  CLOSING_CHECKLIST_HASH,
  evaluateClosing,
  isClosingKind,
} from '../src/closing.js';
import { buildPassaporte } from '../src/passport.js';
import worker from '../src/index.js';
import {
  hashPassword,
  verifyPassword,
  getSessionToken,
  sessionCookie,
  clearSessionCookie,
  SESSION_TTL_MS,
} from '../src/auth.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(RAIZ, 'fixtures');

/* ------------------------------------------------------------------------ */
/* canonical.js                                                              */
/* ------------------------------------------------------------------------ */

test('canonicalStringify: ordena chaves e serializa sem espaços', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalStringify({ z: { y: 1, x: [3, { b: 2, a: 1 }] }, a: null }),
    '{"a":null,"z":{"x":[3,{"a":1,"b":2}],"y":1}}'
  );
  // undefined em objeto é omitido; em array vira null (como JSON.stringify)
  assert.equal(canonicalStringify({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalStringify([undefined, 1]), '[null,1]');
  // strings e escapes
  assert.equal(canonicalStringify({ s: 'a"b\nc' }), '{"s":"a\\"b\\nc"}');
});

test('sha256Hex: vetor conhecido "abc"', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  // ArrayBuffer também funciona
  const buf = new TextEncoder().encode('abc').buffer;
  assert.equal(
    await sha256Hex(buf),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

/* ------------------------------------------------------------------------ */
/* nfe.js                                                                    */
/* ------------------------------------------------------------------------ */

const CHAVE1 = '35260811222333000181550010000001011202608015';
const CHAVE2 = '35260811222333000181550010000001021202608027';
const CHAVE3 = '35260811222333000181550010000001031202608039';

test('parseNFe: extrai todos os campos do nfeProc (fixture nfe-1)', async () => {
  const xml = await readFile(path.join(FIXTURES, 'nfe/nfe-1.xml'), 'utf8');
  const nfe = parseNFe(xml);
  assert.equal(nfe.chave, CHAVE1);
  assert.equal(nfe.numero, '101');
  assert.equal(nfe.serie, '1');
  assert.equal(nfe.data_emissao, '2026-08-05');
  assert.equal(nfe.emitente_cnpj, '11222333000181');
  assert.equal(nfe.destinatario_cnpj, '44555666000177');
  assert.equal(nfe.valor_bc_icms, 1000);
  assert.equal(nfe.valor_icms, 180);
  assert.equal(nfe.valor_total, 1000);
});

test('parseNFe: aceita NFe pura (sem nfeProc) — fixture nfe-2', async () => {
  const xml = await readFile(path.join(FIXTURES, 'nfe/nfe-2.xml'), 'utf8');
  const nfe = parseNFe(xml);
  assert.equal(nfe.chave, CHAVE2);
  assert.equal(nfe.valor_icms, 450);
});

test('parseNFe: chave via <chNFe> quando @Id está ausente', () => {
  const xml =
    '<NFe><infNFe versao="4.00"><ide><nNF>9</nNF><serie>1</serie>' +
    '<dhEmi>2026-08-01T00:00:00-03:00</dhEmi></ide>' +
    '<emit><CNPJ>11222333000181</CNPJ></emit>' +
    '<total><ICMSTot><vBC>1.00</vBC><vICMS>0.18</vICMS><vNF>1.00</vNF></ICMSTot></total>' +
    '</infNFe></NFe><protNFe><infProt><chNFe>' +
    CHAVE3 +
    '</chNFe></infProt></protNFe>';
  assert.equal(parseNFe(xml).chave, CHAVE3);
});

test('parseNFe: lança erro descritivo em XML malformado', () => {
  assert.throws(() => parseNFe('isso não é xml'), /parseNFe:/);
  assert.throws(() => parseNFe('<foo><bar></foo>'), /parseNFe:/);
  assert.throws(() => parseNFe(''), /parseNFe:/);
  // infNFe sem chave nenhuma
  assert.throws(
    () => parseNFe('<NFe><infNFe><ide></ide></infNFe></NFe>'),
    /parseNFe:/
  );
});

/* ------------------------------------------------------------------------ */
/* efd.js                                                                    */
/* ------------------------------------------------------------------------ */

test('parseEFD: período, CNPJ, C100, E110 e totais (fixture efd-a)', async () => {
  const sped = await readFile(path.join(FIXTURES, 'efd/efd-a.txt'), 'utf8');
  const efd = parseEFD(sped);
  assert.deepEqual(efd.periodo, { dt_ini: '2026-08-01', dt_fin: '2026-08-31' });
  assert.equal(efd.cnpj_declarante, '11222333000181');
  assert.equal(efd.totais.qtd_c100, 3);
  assert.equal(efd.totais.soma_vl_doc, 7500);
  assert.deepEqual(
    efd.notas.map((n) => n.chave),
    [CHAVE1, CHAVE2, CHAVE3]
  );
  assert.equal(efd.notas[0].numero, '101');
  assert.equal(efd.notas[0].data_doc, '2026-08-05');
  assert.equal(efd.notas[0].ind_oper, '1');
  assert.equal(efd.notas[0].ind_emit, '0');
  assert.deepEqual(efd.apuracao, {
    vl_tot_debitos: 1350,
    vl_sld_devedor: 1350,
    vl_sld_credor_at: 1350,
  });
});

test('parseEFD: erro quando 0000 está ausente e em DDMMAAAA inválido', () => {
  assert.throws(() => parseEFD('|C001|0|\n|C990|2|'), /registro 0000/);
  assert.throws(
    () =>
      parseEFD(
        '|0000|015|0|20260801|31082026|X|11222333000181||35|1|3550308|||A|'
      ),
    /DDMMAAAA|data impossível/
  );
});

/* ------------------------------------------------------------------------ */
/* checks.js — cada check isolado com fixture mínima inline                  */
/* ------------------------------------------------------------------------ */

const RULESET_MIN = { required_docs: ['efd_icms_ipi', 'nfe_xml', 'apuracao'] };

test('DOC-COMPLETE: lista kinds ausentes; sem achado quando completo', () => {
  const f = docComplete({
    docs: [{ kind: 'nfe_xml' }],
    ruleset: RULESET_MIN,
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].check, 'DOC-COMPLETE');
  assert.equal(f[0].severity, 'critica');
  assert.deepEqual(f[0].evidence.missing, ['apuracao', 'efd_icms_ipi']);
  assert.equal(
    docComplete({
      docs: [{ kind: 'nfe_xml' }, { kind: 'efd_icms_ipi' }, { kind: 'apuracao' }],
      ruleset: RULESET_MIN,
    }).length,
    0
  );
});

test('PERIODO-COERENTE: dispara quando referência sai do intervalo da EFD', () => {
  const parsed = { efd: { periodo: { dt_ini: '2026-08-01', dt_fin: '2026-08-31' } } };
  assert.equal(
    periodoCoerente({
      parsed,
      params: { reference_period: { from: '2026-08-01', to: '2026-08-31' } },
    }).length,
    0
  );
  const f = periodoCoerente({
    parsed,
    params: { reference_period: { from: '2026-07-01', to: '2026-08-31' } },
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'alta');
  assert.deepEqual(f[0].evidence.efd_periodo, {
    from: '2026-08-01',
    to: '2026-08-31',
  });
});

test('VAL-012-NFE-AUSENTE-EFD: chaves do XML fora dos C100', () => {
  const parsed = {
    nfes: [{ chave: CHAVE1 }, { chave: CHAVE2 }, { chave: CHAVE2 }],
    efd: { notas: [{ chave: CHAVE1 }] },
  };
  const f = nfeAusenteEfd({ parsed });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'alta');
  assert.deepEqual(f[0].evidence.chaves, [CHAVE2]); // dedup + ordenado
  assert.equal(f[0].evidence.total_ausentes, 1);
  // sem EFD → check não se aplica
  assert.equal(nfeAusenteEfd({ parsed: { nfes: [{ chave: CHAVE1 }], efd: null } }).length, 0);
});

test('VAL-006-CHAVE-DUPLICADA: só dispara com divergência real', () => {
  // XMLs idênticos na chave, icms e data → SEM achado
  assert.equal(
    chaveDuplicada({
      parsed: {
        nfes: [
          { chave: CHAVE1, valor_icms: 180, data_emissao: '2026-08-05' },
          { chave: CHAVE1, valor_icms: 180, data_emissao: '2026-08-05' },
        ],
      },
    }).length,
    0
  );
  // divergência em valor_icms OU data_emissao → achado critica
  const f = chaveDuplicada({
    parsed: {
      nfes: [
        { chave: CHAVE1, valor_icms: 180, data_emissao: '2026-08-05' },
        { chave: CHAVE1, valor_icms: 170, data_emissao: '2026-08-05' },
      ],
    },
  });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'critica');
  assert.equal(f[0].evidence.chave, CHAVE1);
  assert.equal(f[0].evidence.divergencias.ocorrencias, 2);
});

test('VALOR-POSITIVO: ausente, zero e negativo disparam; positivo não', () => {
  assert.equal(valorPositivo({ params: {} }).length, 1);
  assert.equal(valorPositivo({ params: { amount_cents: 0 } }).length, 1);
  assert.equal(valorPositivo({ params: { amount_cents: -5 } }).length, 1);
  assert.equal(valorPositivo({ params: { amount_cents: 1 } }).length, 0);
  assert.equal(
    valorPositivo({ params: {} })[0].severity,
    'critica'
  );
});

test('IE-PRESENTE: vazio/ausente dispara; preenchido não', () => {
  assert.equal(iePresente({ params: {} }).length, 1);
  assert.equal(iePresente({ params: { state_registration: '  ' } }).length, 1);
  assert.equal(
    iePresente({ params: { state_registration: '123456789110' } }).length,
    0
  );
  assert.equal(iePresente({ params: {} })[0].severity, 'alta');
});

test('executarChecks: ordem determinística por check', () => {
  const ctx = {
    docs: [],
    parsed: { nfes: [], efd: null, skipped: [], errors: [] },
    params: {},
    ruleset: RULESET_MIN,
  };
  const findings = executarChecks(ctx);
  const ids = findings.map((f) => f.check);
  const ordenado = [...ids].sort();
  assert.deepEqual(ids, ordenado);
});

/* ------------------------------------------------------------------------ */
/* rating.js                                                                 */
/* ------------------------------------------------------------------------ */

test('ratingV1: base, rebaixamentos e piso', () => {
  assert.equal(ratingV1({ completude: 1, findings: [] }).grade, 'A');
  assert.equal(ratingV1({ completude: 0.75, findings: [] }).grade, 'B');
  assert.equal(ratingV1({ completude: 0.5, findings: [] }).grade, 'C');
  // DOC-COMPLETE NÃO rebaixa (já precificado na completude)
  assert.equal(
    ratingV1({
      completude: 0.75,
      findings: [{ check: 'DOC-COMPLETE', severity: 'critica' }],
    }).grade,
    'B'
  );
  // critica fiscal rebaixa 1
  assert.equal(
    ratingV1({
      completude: 1,
      findings: [{ check: 'VAL-006-CHAVE-DUPLICADA', severity: 'critica' }],
    }).grade,
    'B'
  );
  // ≥3 findings rebaixa mais 1, piso C
  assert.equal(
    ratingV1({
      completude: 1,
      findings: [
        { check: 'X', severity: 'alta' },
        { check: 'Y', severity: 'alta' },
        { check: 'Z', severity: 'alta' },
      ],
    }).grade,
    'B'
  );
  const r = ratingV1({ completude: 1, findings: [] });
  assert.equal(r.g, 0.01);
  assert.equal(r.detalhe.heuristico, 'rating_v1');
});

/* ------------------------------------------------------------------------ */
/* manifest.js                                                               */
/* ------------------------------------------------------------------------ */

test('buildManifest: ordenação estável + hash independente da ordem de envio', async () => {
  const d1 = { kind: 'nfe_xml', name: 'b.xml', bytes: 2, sha256: 'bb' };
  const d2 = { kind: 'efd_icms_ipi', name: 'a.txt', bytes: 1, sha256: 'aa' };
  const m1 = await buildManifest([d1, d2]);
  const m2 = await buildManifest([d2, d1]);
  assert.equal(m1.manifest_hash, m2.manifest_hash);
  assert.deepEqual(
    m1.files.map((f) => f.kind),
    ['efd_icms_ipi', 'nfe_xml']
  );
  assert.equal(typeof (await buildOutputHash({ a: 1 })), 'string');
});

/* ------------------------------------------------------------------------ */
/* engine.js — casos golden + reprodutibilidade                              */
/* ------------------------------------------------------------------------ */

async function carregaDocumentos(caso) {
  const docs = [];
  for (const d of caso.documents) {
    const caminho = path.join(FIXTURES, d.arquivo);
    const bytes = await readFile(caminho);
    const doc = {
      kind: d.kind,
      name: path.basename(d.arquivo),
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    };
    // Só kinds parseáveis carregam text (espelha o contrato do intake).
    if (d.kind === 'nfe_xml' || d.kind === 'efd_icms_ipi') {
      doc.text = bytes.toString('utf8');
    }
    docs.push(doc);
  }
  return docs;
}

const casosJson = JSON.parse(
  await readFile(path.join(FIXTURES, 'casos.json'), 'utf8')
);

for (const caso of casosJson.casos) {
  test(`engine: caso ${caso.id} — rating ${caso.esperado.rating}, ${caso.esperado.qtd_findings} findings`, async () => {
    const documents = await carregaDocumentos(caso);
    const { dossier } = await executar({
      documents,
      ruleset: RULESET,
      params: casosJson.params_comuns,
    });
    assert.equal(dossier.rating.grade, caso.esperado.rating);
    assert.equal(dossier.findings.length, caso.esperado.qtd_findings);
    assert.equal(dossier.completude, caso.esperado.completude);
    assert.deepEqual(
      dossier.findings.map((f) => f.check),
      caso.esperado.checks
    );
    assert.equal(dossier.ruleset.rule_id, 'BR-SP-CAT42');
    assert.equal(dossier.ruleset.version, 'v2026.09');
    assert.match(dossier.input_hash, /^[0-9a-f]{64}$/);
    assert.match(dossier.output_hash, /^[0-9a-f]{64}$/);
  });
}

test('engine: caso A — parsed_resumo coerente com os fixtures', async () => {
  const casoA = casosJson.casos.find((c) => c.id === 'A');
  const documents = await carregaDocumentos(casoA);
  const { dossier } = await executar({
    documents,
    ruleset: RULESET,
    params: casosJson.params_comuns,
  });
  assert.equal(dossier.parsed_resumo.qtd_nfe, 3);
  assert.equal(dossier.parsed_resumo.qtd_c100, 3);
  assert.deepEqual(dossier.parsed_resumo.periodo_efd, {
    dt_ini: '2026-08-01',
    dt_fin: '2026-08-31',
  });
  assert.deepEqual(dossier.parsed_resumo.skipped, []);
  assert.deepEqual(dossier.parsed_resumo.errors, []);
});

test('engine: documento parseável sem text → skipped, sem inventar dados', async () => {
  const casoA = casosJson.casos.find((c) => c.id === 'A');
  const documents = (await carregaDocumentos(casoA)).map((d) =>
    d.kind === 'efd_icms_ipi' ? { ...d, text: undefined } : d
  );
  const { dossier } = await executar({
    documents,
    ruleset: RULESET,
    params: casosJson.params_comuns,
  });
  assert.equal(dossier.parsed_resumo.qtd_c100, 0);
  assert.equal(dossier.parsed_resumo.periodo_efd, null);
  assert.equal(dossier.parsed_resumo.skipped.length, 1);
  assert.equal(dossier.parsed_resumo.skipped[0].kind, 'efd_icms_ipi');
});

/* ------------------------------------------------------------------------ */
/* closing.js — Checklist de Fechamento (diligência da contraparte)          */
/* ------------------------------------------------------------------------ */

const CLOSING_COMPLETO = [
  { kind: 'cartao_cnpj' },
  { kind: 'contrato_social' },
  { kind: 'inscricao_estadual' },
  { kind: 'cnd_estadual' },
  { kind: 'politica_governanca' },
  { kind: 'balanco', competencia: '2026-06' },
  { kind: 'balanco', competencia: '2026-07' },
  { kind: 'balanco', competencia: '2026-08' },
  { kind: 'nda' },
  { kind: 'procuracao' },
];

const BODY_BASE = {
  holder_org_id: 'cnpj_11222333000181',
  amount_cents: 250000000,
  reference_period: { from: '2026-08-01', to: '2026-08-31' },
  documents: [],
};

test('passaporte SEM closing: sem campo "closing" e ruleset_hash golden intacto', async () => {
  const p = await buildPassaporte({ ...BODY_BASE });
  assert.equal('closing' in p, false);
  // Golden congelado: o módulo de fechamento NÃO pode alterar o hash do ruleset fiscal.
  assert.equal(
    p.ruleset_hash,
    'sha256:49878474f494a1545a3c3e94a04f4b031e9057d25c5e734fd9fe294e98f383d7'
  );
  assert.equal(RULESET_HASH, p.ruleset_hash);
});

test('evaluateClosing: checklist completo → completeness 1, sem missing/pending', () => {
  const r = evaluateClosing(CLOSING_COMPLETO);
  assert.equal(r.completeness, 1);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.pending_signature, []);
  assert.equal(r.present.length, CLOSING_CHECKLIST.itens.length);
  assert.equal(r.details.balanco.present_count, 3);
  assert.match(r.checklist_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.checklist_hash, CLOSING_CHECKLIST_HASH);
  assert.equal(r.version, 'FECHAMENTO@v1');
});

test('evaluateClosing: balanco com só 2 competências → "balanco" em missing', () => {
  const itens = CLOSING_COMPLETO.filter(
    (d) => !(d.kind === 'balanco' && d.competencia === '2026-08')
  );
  const r = evaluateClosing(itens);
  assert.ok(r.missing.includes('balanco'));
  assert.equal(r.details.balanco.present_count, 2);
  // sem competencia, o fallback conta instâncias (3 balancos "soltos" bastam)
  const r2 = evaluateClosing([{ kind: 'balanco' }, { kind: 'balanco' }, { kind: 'balanco' }]);
  assert.ok(r2.present.includes('balanco'));
  assert.equal(r2.details.balanco.present_count, 3);
});

test('evaluateClosing: sem nda/procuracao → pending_signature, NÃO missing', () => {
  const itens = CLOSING_COMPLETO.filter((d) => d.kind !== 'nda' && d.kind !== 'procuracao');
  const r = evaluateClosing(itens);
  assert.deepEqual(r.pending_signature, ['nda', 'procuracao']);
  assert.deepEqual(r.missing, []);
  assert.equal(r.present.includes('nda'), false);
  // isClosingKind: kinds do checklist reconhecidos; kinds fiscais não
  assert.equal(isClosingKind('nda'), true);
  assert.equal(isClosingKind('balanco'), true);
  assert.equal(isClosingKind('nfe_xml'), false);
});

test('buildPassaporte com body.closing → campo closing com checklist_hash sha256:', async () => {
  const p = await buildPassaporte({ ...BODY_BASE, closing: CLOSING_COMPLETO });
  assert.ok(p.closing);
  assert.match(p.closing.checklist_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(p.closing.completeness, 1);
  assert.deepEqual(p.closing.missing, []);
  assert.deepEqual(p.closing.pending_signature, []);
  // O fechamento NÃO altera o rating fiscal nem o ruleset_hash.
  assert.equal(p.rating.grade, 'C'); // documents: [] → grade C, como antes
  assert.equal(
    p.ruleset_hash,
    'sha256:49878474f494a1545a3c3e94a04f4b031e9057d25c5e734fd9fe294e98f383d7'
  );
});

test('REPRODUTIBILIDADE: 2 execuções → output_hash idêntico (casos A e C)', async () => {
  for (const id of ['A', 'C']) {
    const caso = casosJson.casos.find((c) => c.id === id);
    const documents = await carregaDocumentos(caso);
    const r1 = await executar({
      documents,
      ruleset: RULESET,
      params: casosJson.params_comuns,
    });
    // embaralha a ordem dos documentos para provar independência de ordem
    const r2 = await executar({
      documents: [...documents].reverse(),
      ruleset: RULESET,
      params: casosJson.params_comuns,
    });
    assert.equal(r1.dossier.output_hash, r2.dossier.output_hash);
    assert.equal(r1.dossier.input_hash, r2.dossier.input_hash);
    assert.equal(
      canonicalStringify(r1.dossier),
      canonicalStringify(r2.dossier)
    );
  }
});

/* ------------------------------------------------------------------------ */
/* auth.js — hash de senha e token de sessão (puros, sem D1)                 */
/* ------------------------------------------------------------------------ */

test('hashPassword: formato pbkdf2$sha256$100000$<salt>$<hash> (teto Workers) e salt aleatório', async () => {
  const h1 = await hashPassword('senha-forte-123');
  const h2 = await hashPassword('senha-forte-123');
  assert.match(h1, /^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  // Mesma senha → hashes diferentes (salt de 16 bytes aleatório por hash)
  assert.notEqual(h1, h2);
});

test('verifyPassword: aceita a senha certa e recusa a errada', async () => {
  const stored = await hashPassword('correta-456');
  assert.equal(await verifyPassword('correta-456', stored), true);
  assert.equal(await verifyPassword('errada-456', stored), false);
});

test('verifyPassword: formato inválido → false, sem throw', async () => {
  assert.equal(await verifyPassword('x', 'não-é-um-hash'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$md5$100000$AAAA$BBBB'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$sha256$abc$AAAA$BBBB'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$sha256$100000$@@@$BBBB'), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', undefined), false);
});

test('getSessionToken: cookie kilo_session, Bearer e ausência', () => {
  const viaCookie = new Request('https://t.local/api/me', {
    headers: { Cookie: 'a=1; kilo_session=tok-abc; b=2' },
  });
  assert.equal(getSessionToken(viaCookie), 'tok-abc');
  const viaBearer = new Request('https://t.local/api/me', {
    headers: { Authorization: 'Bearer tok-xyz' },
  });
  assert.equal(getSessionToken(viaBearer), 'tok-xyz');
  // cookie tem precedência sobre Bearer
  const ambos = new Request('https://t.local/api/me', {
    headers: { Cookie: 'kilo_session=tok-cookie', Authorization: 'Bearer tok-bearer' },
  });
  assert.equal(getSessionToken(ambos), 'tok-cookie');
  assert.equal(getSessionToken(new Request('https://t.local/api/me')), null);
});

test('sessionCookie/clearSessionCookie: flags de segurança presentes', () => {
  const c = sessionCookie('tok123');
  assert.ok(c.includes('kilo_session=tok123'));
  assert.ok(c.includes('HttpOnly'));
  assert.ok(c.includes('Secure'));
  assert.ok(c.includes('SameSite=Lax'));
  assert.ok(c.includes('Max-Age=604800'));
  assert.equal(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const clear = clearSessionCookie();
  assert.ok(clear.includes('kilo_session=;'));
  assert.ok(clear.includes('Max-Age=0'));
});

/* ------------------------------------------------------------------------ */
/* Autenticação v1 — e2e do Worker com mockD1() em memória                   */
/* ------------------------------------------------------------------------ */

// Mock de teste: D1 mínimo em memória (arrays), ESPECIALIZADO por substring do
// SQL — cobre apenas as operações de src/authdb.js (INSERT/SELECT users,
// INSERT/SELECT-JOIN/DELETE sessions). Não é um SQLite genérico: SQL fora
// desse conjunto lança erro (ex.: o SQL de rate_limits cai no catch do
// checkRateLimit, que degrada para o fallback em memória — ver ratelimit.js).
function mockD1() {
  const users = []; // { id, org_id, nome, email, senha_hash, created_at, updated_at }
  const sessions = []; // { token_hash, user_id, created_at, expires_at, ip, user_agent }

  function run(sql, args) {
    if (sql.startsWith('INSERT INTO users')) {
      // UNIQUE(users.email), como na migration 0003
      if (users.some((u) => u.email === args[3])) {
        throw new Error('UNIQUE constraint failed: users.email');
      }
      users.push({
        id: args[0], org_id: args[1], nome: args[2], email: args[3],
        senha_hash: args[4], created_at: args[5], updated_at: args[6],
      });
      return { changes: 1 };
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      sessions.push({
        token_hash: args[0], user_id: args[1], created_at: args[2],
        expires_at: args[3], ip: args[4], user_agent: args[5],
      });
      return { changes: 1 };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
      const antes = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].expires_at < args[0]) sessions.splice(i, 1);
      }
      return { changes: antes - sessions.length };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE token_hash')) {
      const antes = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].token_hash === args[0]) sessions.splice(i, 1);
      }
      return { changes: antes - sessions.length };
    }
    throw new Error('mockD1: SQL não suportado (run): ' + sql);
  }

  function first(sql, args) {
    if (sql.includes('FROM users') && !sql.includes('JOIN')) {
      return users.find((u) => u.email === args[0]) || null;
    }
    if (sql.includes('FROM sessions') && sql.includes('JOIN')) {
      const s = sessions.find((x) => x.token_hash === args[0]);
      if (!s) return null;
      const u = users.find((x) => x.id === s.user_id);
      if (!u) return null;
      return { expires_at: s.expires_at, id: u.id, org_id: u.org_id, nome: u.nome, email: u.email };
    }
    throw new Error('mockD1: SQL não suportado (first): ' + sql);
  }

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return { run: async () => run(sql, args), first: async () => first(sql, args) };
        },
      };
    },
  };
}

// Chama o Worker como a borda faria (fetch do handler, passando pelo withCors).
function callApi(env, method, path, { body, headers = {} } = {}) {
  const req = new Request('https://teste.local' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return worker.fetch(req, env, {});
}

const CADASTRO = {
  nome: 'Maria Silva',
  email: 'Maria@Empresa.com.br',
  senha: 'senha-forte-123',
  org_id: 'cnpj_11222333000181',
};

// POST /api/auth/register tem limite de 5/min por IP (v2). Os testes deste
// arquivo somam mais de 5 registros e rodam na mesma janela de 60 s, então
// cada teste usa um cf-connecting-ip próprio para isolar o bucket do limiter.
const IP1 = { 'cf-connecting-ip': '10.10.0.1' };
const IP2 = { 'cf-connecting-ip': '10.10.0.2' };
const IP3 = { 'cf-connecting-ip': '10.10.0.3' };
const IP4 = { 'cf-connecting-ip': '10.10.0.4' };
const IP5 = { 'cf-connecting-ip': '10.10.0.5' };
const IP6 = { 'cf-connecting-ip': '10.10.0.6' };

test('auth e2e: register 201 com Set-Cookie → /api/me com cookie → 200', async () => {
  const env = { DB: mockD1() };
  const res = await worker.fetch(
    new Request('https://teste.local/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...IP1 },
      body: JSON.stringify(CADASTRO),
    }),
    env,
    {}
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.match(data.user.id, /^usr_/);
  // e-mail normalizado (trim + lowercase) e senha_hash NUNCA exposto
  assert.equal(data.user.email, 'maria@empresa.com.br');
  assert.equal(data.user.org_id, CADASTRO.org_id);
  assert.equal('senha_hash' in data.user, false);
  assert.equal(typeof data.session_token, 'string');
  assert.equal(typeof data.session_expires_at, 'string');
  // cookie sobrevive ao wrapper withCors (que copia os headers)
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie && setCookie.includes('kilo_session=' + data.session_token));
  assert.ok(setCookie.includes('HttpOnly'));

  const me = await callApi(env, 'GET', '/api/me', {
    headers: { Cookie: 'kilo_session=' + data.session_token },
  });
  assert.equal(me.status, 200);
  const meData = await me.json();
  assert.equal(meData.user.email, 'maria@empresa.com.br');
  assert.equal(meData.session_expires_at, data.session_expires_at);

  // Bearer também funciona
  const meBearer = await callApi(env, 'GET', '/api/me', {
    headers: { Authorization: 'Bearer ' + data.session_token },
  });
  assert.equal(meBearer.status, 200);
});

test('auth e2e: login com senha errada → 401 AUTH_FAILED; correta → 200', async () => {
  const env = { DB: mockD1() };
  const reg = await callApi(env, 'POST', '/api/auth/register', { body: CADASTRO, headers: IP2 });
  assert.equal(reg.status, 201);

  const errada = await callApi(env, 'POST', '/api/auth/login', {
    body: { email: CADASTRO.email, senha: 'senha-errada-1' },
  });
  assert.equal(errada.status, 401);
  assert.equal((await errada.json()).error.code, 'AUTH_FAILED');

  // usuário inexistente: MESMA resposta (anti-enumeração)
  const inexistente = await callApi(env, 'POST', '/api/auth/login', {
    body: { email: 'ninguem@empresa.com.br', senha: 'senha-errada-1' },
  });
  assert.equal(inexistente.status, 401);
  assert.equal((await inexistente.json()).error.code, 'AUTH_FAILED');

  const certa = await callApi(env, 'POST', '/api/auth/login', {
    body: { email: 'maria@empresa.com.br', senha: CADASTRO.senha },
  });
  assert.equal(certa.status, 200);
  const loginData = await certa.json();
  assert.equal(loginData.user.email, 'maria@empresa.com.br');
  assert.equal(typeof loginData.session_token, 'string');
  assert.ok((certa.headers.get('set-cookie') || '').includes('kilo_session='));

  // formato inválido → 400
  const semSenha = await callApi(env, 'POST', '/api/auth/login', {
    body: { email: CADASTRO.email },
  });
  assert.equal(semSenha.status, 400);
  assert.equal((await semSenha.json()).error.code, 'INVALID_CREDENTIALS_FORMAT');
});

test('auth e2e: register com mesmo e-mail → 409 EMAIL_TAKEN', async () => {
  const env = { DB: mockD1() };
  const r1 = await callApi(env, 'POST', '/api/auth/register', { body: CADASTRO, headers: IP3 });
  assert.equal(r1.status, 201);
  // mesmo e-mail normalizado (case-insensitive)
  const r2 = await callApi(env, 'POST', '/api/auth/register', {
    body: { ...CADASTRO, email: 'MARIA@empresa.com.br' },
    headers: IP3,
  });
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).error.code, 'EMAIL_TAKEN');
});

test('auth e2e: validações 400 do register', async () => {
  const env = { DB: mockD1() };
  const senhaFraca = await callApi(env, 'POST', '/api/auth/register', {
    body: { ...CADASTRO, senha: 'curta' },
    headers: IP4,
  });
  assert.equal(senhaFraca.status, 400);
  assert.equal((await senhaFraca.json()).error.code, 'AUTH_WEAK_PASSWORD');

  const semOrg = await callApi(env, 'POST', '/api/auth/register', {
    body: { ...CADASTRO, org_id: '' },
    headers: IP4,
  });
  assert.equal(semOrg.status, 400);

  const emailRuim = await callApi(env, 'POST', '/api/auth/register', {
    body: { ...CADASTRO, email: 'sem-arroba' },
    headers: IP4,
  });
  assert.equal(emailRuim.status, 400);
});

test('auth e2e: logout → 200 e /api/me depois → 401 AUTH_REQUIRED', async () => {
  const env = { DB: mockD1() };
  const reg = await callApi(env, 'POST', '/api/auth/register', { body: CADASTRO, headers: IP5 });
  const { session_token } = await reg.json();

  const logout = await callApi(env, 'POST', '/api/auth/logout', {
    headers: { Cookie: 'kilo_session=' + session_token },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  const clearCookie = logout.headers.get('set-cookie');
  assert.ok(clearCookie && clearCookie.includes('Max-Age=0'));

  const me = await callApi(env, 'GET', '/api/me', {
    headers: { Cookie: 'kilo_session=' + session_token },
  });
  assert.equal(me.status, 401);
  assert.equal((await me.json()).error.code, 'AUTH_REQUIRED');

  // logout sem token também é 200 (idempotente)
  const logoutSemToken = await callApi(env, 'POST', '/api/auth/logout');
  assert.equal(logoutSemToken.status, 200);
});

test('auth e2e: sem binding D1 → 503 AUTH_UNAVAILABLE', async () => {
  const reg = await callApi({}, 'POST', '/api/auth/register', { body: CADASTRO, headers: IP6 });
  assert.equal(reg.status, 503);
  assert.equal((await reg.json()).error.code, 'AUTH_UNAVAILABLE');

  const me = await callApi({}, 'GET', '/api/me');
  assert.equal(me.status, 503);
});
