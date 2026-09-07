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
