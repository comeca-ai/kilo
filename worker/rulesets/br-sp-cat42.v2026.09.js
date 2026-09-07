/**
 * br-sp-cat42.v2026.09.js — ruleset imutável BR-SP-CAT42, versão v2026.09.
 *
 * Escopo: crédito acumulado de ICMS — Estado de São Paulo, estrutura
 * preparada para a CAT 42/SP (documentação comprobatória de crédito
 * acumulado). ⚠️ ESTE RULESET É ESTRUTURAL: os required_docs e checks
 * abaixo refletem o recorte implementado no motor v1 e AINDA PRECISAM de
 * revisão por especialista fiscal + golden files assinados contra o layout
 * oficial da CAT 42/SP antes de uso em produção (ver INTAKE-MOTOR.md).
 *
 * Imutabilidade: o objeto exportado é congelado em profundidade. Qualquer
 * mudança de regra = NOVO arquivo de versão (nunca editar em produção).
 *
 * ruleset_hash: SHA-256 do JSON canônico do ruleset SEM o próprio campo
 * ruleset_hash — permite verificar integridade/identidade do ruleset.
 */

import { canonicalStringify, sha256Hex } from '../motor/canonical.js';

/** Congela um objeto recursivamente (profundo). */
function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const valor of Object.values(obj)) deepFreeze(valor);
    Object.freeze(obj);
  }
  return obj;
}

const RULESET_BASE = {
  rule_id: 'BR-SP-CAT42',
  version: 'v2026.09',
  jurisdiction: 'BR-SP',
  credit_kind: 'ICMS_ACCUMULATED',
  required_docs: ['efd_icms_ipi', 'nfe_xml', 'apuracao', 'livro_registro'],
  checks: [
    {
      id: 'DOC-COMPLETE',
      desc: 'Documentos exigidos pelo ruleset ausentes no dossiê (critica).',
    },
    {
      id: 'PERIODO-COERENTE',
      desc: 'Período de referência do pedido fora do intervalo DT_INI/DT_FIN da EFD (alta).',
    },
    {
      id: 'VAL-012-NFE-AUSENTE-EFD',
      desc: 'Chave de NF-e presente nos XMLs e ausente nos registros C100 da EFD (alta).',
    },
    {
      id: 'VAL-006-CHAVE-DUPLICADA',
      desc: 'Mesma chave de 44 dígitos em 2+ XMLs com valor_icms ou data_emissao divergentes (critica).',
    },
    {
      id: 'VALOR-POSITIVO',
      desc: 'Valor do crédito pleiteado (amount_cents) ausente ou não positivo (critica).',
    },
    {
      id: 'IE-PRESENTE',
      desc: 'Inscrição estadual (state_registration) ausente (alta).',
    },
  ],
};

// Hash de identidade do ruleset (conteúdo canônico, sem o próprio hash).
// Top-level await é suportado em Node 18+ (ESM) e em Cloudflare Workers.
const ruleset_hash = await sha256Hex(canonicalStringify(RULESET_BASE));

export const RULESET = deepFreeze({ ...RULESET_BASE, ruleset_hash });

export default RULESET;
