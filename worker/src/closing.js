// closing.js — Checklist de Fechamento (diligência da contraparte).
//
// Este módulo é SEPARADO do ruleset fiscal (src/ruleset.js): o checklist de
// fechamento cobre documentos de diligência/KYC exigidos pela contraparte na
// hora de fechar a operação, e NÃO altera o rating fiscal A/B/C nem o
// ruleset_hash do passaporte. Para manter a reprodutibilidade (mesma entrada →
// mesmo resultado, auditável externamente), o checklist tem versão e hash
// próprios: CLOSING_VERSION e CLOSING_CHECKLIST_HASH (SHA-256 do JSON canônico
// do checklist, mesmo algoritmo de src/canonical.js).
//
// Duas categorias de itens:
//   - "possuido": documento que a organização já deve ter (ausência = falta);
//   - "a_assinar": instrumento a assinar no fechamento (ausência = pendência,
//     não falha — vai para pending_signature, não para missing).

import { sha256HexCanonical } from './canonical.js';

export const CLOSING_VERSION = 'FECHAMENTO@v1';

export const CLOSING_CHECKLIST = Object.freeze({
  checklist_id: 'FECHAMENTO',
  version: 'v1',
  desc: 'Documentos de fechamento exigidos pela contraparte (diligência/KYC), independentes da rota fiscal.',
  itens: Object.freeze([
    { kind: 'cartao_cnpj', label: 'Cartão CNPJ (comprovante de inscrição)', categoria: 'possuido' },
    { kind: 'contrato_social', label: 'Contrato social consolidado', categoria: 'possuido' },
    { kind: 'inscricao_estadual', label: 'Comprovante de Inscrição Estadual (I.E.)', categoria: 'possuido' },
    { kind: 'cnd_estadual', label: 'CND Estadual (certidão negativa de débitos)', categoria: 'possuido' },
    { kind: 'politica_governanca', label: 'Política de governança/compliance', categoria: 'possuido' },
    { kind: 'balanco', label: 'Balanço/balancete (3 últimos meses)', categoria: 'possuido', min_count: 3 },
    { kind: 'nda', label: 'NDA assinado', categoria: 'a_assinar' },
    { kind: 'procuracao', label: 'Procuração', categoria: 'a_assinar' },
  ]),
});

// "sha256:<hex64>" — computado uma única vez no carregamento do isolate (mesmo
// padrão do RULESET_HASH; top-level await é suportado em Workers com ESM).
export const CLOSING_CHECKLIST_HASH = 'sha256:' + (await sha256HexCanonical(CLOSING_CHECKLIST));

const CLOSING_KINDS = new Set(CLOSING_CHECKLIST.itens.map((i) => i.kind));

// True se o kind faz parte do checklist de fechamento.
export function isClosingKind(kind) {
  return CLOSING_KINDS.has(kind);
}

// Competência no formato 'YYYY-MM' (ex.: '2026-08').
const COMPETENCIA_RE = /^\d{4}-\d{2}$/;

// Conta balanços: competências distintas entre os docs kind 'balanco'; se nenhum
// tiver competencia válida, conta instâncias (fallback para quem não informa mês).
function countBalancos(items) {
  const competencias = new Set();
  let instancias = 0;
  for (const d of items) {
    if (!d || typeof d !== 'object' || d.kind !== 'balanco') continue;
    instancias += 1;
    if (typeof d.competencia === 'string' && COMPETENCIA_RE.test(d.competencia)) {
      competencias.add(d.competencia);
    }
  }
  return competencias.size > 0 ? competencias.size : instancias;
}

// Avalia o checklist contra os itens enviados (array de {kind, competencia?},
// pode ser []). Função PURA e determinística: sem relógio, sem aleatoriedade.
export function evaluateClosing(items) {
  const docs = Array.isArray(items) ? items : [];
  const presentKinds = new Set();
  for (const d of docs) {
    if (d && typeof d === 'object' && typeof d.kind === 'string') presentKinds.add(d.kind);
  }

  const balancoCount = countBalancos(docs);

  const present = [];
  const missing = [];
  const pending_signature = [];

  for (const item of CLOSING_CHECKLIST.itens) {
    // balanco exige min_count (3) competências/instâncias; demais bastam 1 doc do kind.
    const ok =
      item.kind === 'balanco'
        ? balancoCount >= (item.min_count || 1)
        : presentKinds.has(item.kind);
    if (ok) {
      present.push(item.kind);
    } else if (item.categoria === 'a_assinar') {
      pending_signature.push(item.kind);
    } else {
      missing.push(item.kind);
    }
  }

  return {
    version: CLOSING_VERSION,
    checklist_hash: CLOSING_CHECKLIST_HASH,
    completeness: present.length / CLOSING_CHECKLIST.itens.length,
    present,
    missing,
    pending_signature,
    details: { balanco: { present_count: balancoCount } },
  };
}
