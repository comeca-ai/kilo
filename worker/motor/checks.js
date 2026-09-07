/**
 * checks.js — checks determinísticos do motor.
 *
 * Cada check é uma FUNÇÃO PURA:
 *   ({ docs, parsed, params, ruleset }) → findings[]
 *
 *   - docs:    [{ kind, name, bytes, sha256, text? }] (documentos do intake)
 *   - parsed:  { nfes: [...], efd: {...}|null, skipped: [...] }
 *   - params:  { reference_period: {from,to}, amount_cents,
 *                state_registration, ... } (datas entram por aqui — o motor
 *              nunca lê o relógio)
 *   - ruleset: { required_docs: [...], ... }
 *
 * Cada finding: { check: "<ID>", severity: "critica"|"alta", evidence: {...} }
 *
 * A lista agregada é ordenada de forma determinística:
 *   1) id do check (ordem lexicográfica);
 *   2) JSON canônico da evidence.
 */

import { canonicalStringify } from './canonical.js';

/** Severidades usadas pelo rating. */
export const SEVERIDADE = Object.freeze({
  CRITICA: 'critica',
  ALTA: 'alta',
});

/** Máximo de chaves na evidence do VAL-012 (evidence não pode explodir). */
const MAX_CHAVES_EVIDENCE = 20;

/**
 * DOC-COMPLETE (critica): kinds exigidos pelo ruleset ausentes no dossiê.
 */
export function docComplete({ docs, ruleset }) {
  const exigidos = (ruleset && ruleset.required_docs) || [];
  const presentes = new Set(docs.map((d) => d.kind));
  const missing = exigidos.filter((k) => !presentes.has(k)).sort();
  if (missing.length === 0) return [];
  return [
    {
      check: 'DOC-COMPLETE',
      severity: SEVERIDADE.CRITICA,
      evidence: { missing },
    },
  ];
}

/**
 * PERIODO-COERENTE (alta): o período de referência do pedido
 * (params.reference_period { from, to } em YYYY-MM-DD) deve estar contido
 * no intervalo [dt_ini, dt_fin] declarado no registro 0000 da EFD.
 *
 * Comparação por string ISO é cronologicamente correta (YYYY-MM-DD ordena).
 * Sem EFD parseada ou sem reference_period → check não se aplica.
 */
export function periodoCoerente({ parsed, params }) {
  const efd = parsed && parsed.efd;
  const ref = params && params.reference_period;
  if (!efd || !ref || !ref.from || !ref.to) return [];

  const { dt_ini, dt_fin } = efd.periodo;
  if (ref.from >= dt_ini && ref.to <= dt_fin) return [];

  return [
    {
      check: 'PERIODO-COERENTE',
      severity: SEVERIDADE.ALTA,
      evidence: {
        efd_periodo: { from: dt_ini, to: dt_fin },
        referencia: { from: ref.from, to: ref.to },
      },
    },
  ];
}

/**
 * VAL-012-NFE-AUSENTE-EFD (alta): chave de NF-e presente nos XMLs do dossiê
 * e ausente nos registros C100 da EFD (nota não escriturada).
 * Evidence limitada a 20 chaves (ordenadas, sem duplicatas).
 */
export function nfeAusenteEfd({ parsed }) {
  if (!parsed || !parsed.efd) return []; // sem EFD não há confronto possível
  const nfes = parsed.nfes || [];
  if (nfes.length === 0) return [];

  const chavesEfd = new Set(
    parsed.efd.notas.map((n) => n.chave).filter((c) => c !== null)
  );
  const ausentes = [
    ...new Set(nfes.map((n) => n.chave).filter((c) => c && !chavesEfd.has(c))),
  ].sort();

  if (ausentes.length === 0) return [];
  return [
    {
      check: 'VAL-012-NFE-AUSENTE-EFD',
      severity: SEVERIDADE.ALTA,
      evidence: {
        chaves: ausentes.slice(0, MAX_CHAVES_EVIDENCE),
        total_ausentes: ausentes.length,
      },
    },
  ];
}

/**
 * VAL-006-CHAVE-DUPLICADA (critica): a mesma chave de 44 dígitos aparece em
 * 2+ XMLs com valor_icms OU data_emissao divergentes (indício de
 * duplicidade/adulteração; XMLs idênticos NÃO disparam o check).
 */
export function chaveDuplicada({ parsed }) {
  const nfes = (parsed && parsed.nfes) || [];
  const porChave = new Map(); // chave → array (Map só interno; saída é ordenada)
  for (const nfe of nfes) {
    if (!nfe.chave) continue;
    if (!porChave.has(nfe.chave)) porChave.set(nfe.chave, []);
    porChave.get(nfe.chave).push(nfe);
  }

  const findings = [];
  for (const chave of [...porChave.keys()].sort()) {
    const grupo = porChave.get(chave);
    if (grupo.length < 2) continue;

    const icmsDistintos = [...new Set(grupo.map((n) => n.valor_icms))];
    const datasDistintas = [...new Set(grupo.map((n) => n.data_emissao))];
    if (icmsDistintos.length < 2 && datasDistintas.length < 2) continue;

    findings.push({
      check: 'VAL-006-CHAVE-DUPLICADA',
      severity: SEVERIDADE.CRITICA,
      evidence: {
        chave,
        divergencias: {
          ocorrencias: grupo.length,
          valor_icms: icmsDistintos,
          data_emissao: datasDistintas,
        },
      },
    });
  }
  return findings;
}

/**
 * VALOR-POSITIVO (critica): o valor do crédito pleiteado
 * (params.amount_cents, em centavos) deve existir e ser > 0.
 */
export function valorPositivo({ params }) {
  const amount = params ? params.amount_cents : undefined;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    return [];
  }
  return [
    {
      check: 'VALOR-POSITIVO',
      severity: SEVERIDADE.CRITICA,
      evidence: { amount_cents: amount === undefined ? null : amount },
    },
  ];
}

/**
 * IE-PRESENTE (alta): inscrição estadual (params.state_registration)
 * obrigatória para crédito acumulado de ICMS.
 */
export function iePresente({ params }) {
  const ie = params ? params.state_registration : undefined;
  if (typeof ie === 'string' && ie.trim() !== '') return [];
  return [
    {
      check: 'IE-PRESENTE',
      severity: SEVERIDADE.ALTA,
      evidence: { state_registration: ie === undefined ? null : ie },
    },
  ];
}

/** Lista de todos os checks (ordem de definição; a saída é reordenada). */
export const TODOS_OS_CHECKS = Object.freeze([
  docComplete,
  periodoCoerente,
  nfeAusenteEfd,
  chaveDuplicada,
  valorPositivo,
  iePresente,
]);

/**
 * Executa todos os checks e devolve findings em ordem determinística:
 * ordena por id do check e, em empate, pelo JSON canônico da evidence.
 */
export function executarChecks(contexto) {
  const findings = [];
  for (const fn of TODOS_OS_CHECKS) {
    for (const f of fn(contexto)) findings.push(f);
  }
  findings.sort((a, b) => {
    if (a.check < b.check) return -1;
    if (a.check > b.check) return 1;
    const ea = canonicalStringify(a.evidence);
    const eb = canonicalStringify(b.evidence);
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
  return findings;
}
