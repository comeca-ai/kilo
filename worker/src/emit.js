// emit.js — POST /api/passaporte v2.
// O passaporte só nasce do dossiê do motor (reexecução de executar()).

import { computePricing, DEFAULT_I, DEFAULT_T } from './pricing.js';
import { jsonResponse, errorResponse, parseJsonBody, isNonEmptyString } from './validate.js';
import { montarDocumentosDoBody, extrairParamsDoBody } from './scan.js';
import {
  buildPassaporteFromDossier,
  signPassaporte,
  hasSigningKey,
} from './passport.js';
import { executar } from '../motor/engine.js';
import { RULESET as MOTOR_RULESET } from '../rulesets/br-sp-cat42.v2026.09.js';

const MAX_AMOUNT_CENTS = 1e15;

function noSigningKey() {
  return errorResponse(503, 'NO_SIGNING_KEY', 'Chave de assinatura não configurada.');
}

export function isPassportV1Body(body) {
  if (!body || typeof body !== 'object') return false;
  const temMotor =
    body.nfe_xml != null ||
    body.efd_text != null ||
    (Array.isArray(body.supporting_docs) && body.supporting_docs.length > 0);
  return Array.isArray(body.documents) && !temMotor;
}

export async function handlePassaporte(request, env) {
  if (!hasSigningKey(env)) return noSigningKey();

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  if (isPassportV1Body(body)) {
    return errorResponse(
      400,
      'PASSPORT_V1_RETIRED',
      'Passaporte v1 (só lista de kinds) foi aposentado. Envie nfe_xml e/ou efd_text — o servidor roda o motor e assina o dossiê. Ver docs/PASSAPORTE-V2.md.',
      'nfe_xml'
    );
  }

  if (!isNonEmptyString(body.holder_org_id)) {
    return errorResponse(400, 'INVALID_HOLDER_ORG_ID', 'Informe holder_org_id (identificador da organização titular).', 'holder_org_id');
  }

  const params = extrairParamsDoBody(body);
  const amount = params.amount_cents;
  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > MAX_AMOUNT_CENTS
  ) {
    return errorResponse(400, 'INVALID_AMOUNT', 'Informe amount_cents como inteiro positivo (valor em centavos).', 'amount_cents');
  }

  if (body.closing !== undefined && !Array.isArray(body.closing)) {
    return errorResponse(400, 'INVALID_CLOSING', 'Informe closing como array de {kind, competencia?} (opcional).', 'closing');
  }

  const montado = await montarDocumentosDoBody(body);
  if (!montado.ok) {
    return errorResponse(400, 'INVALID_SCAN_INPUT', montado.message, montado.field);
  }
  if (montado.documents.length === 0) {
    return errorResponse(
      400,
      'INVALID_SCAN_INPUT',
      'Envie ao menos um documento parseável (nfe_xml e/ou efd_text) ou supporting_docs.'
    );
  }

  const { dossier } = await executar({
    documents: montado.documents,
    ruleset: MOTOR_RULESET,
    params,
  });

  const esperado =
    (body.dossier && body.dossier.output_hash) ||
    body.output_hash ||
    null;
  if (esperado != null && String(esperado).replace(/^sha256:/, '') !== dossier.output_hash) {
    return errorResponse(
      409,
      'DOSSIER_MISMATCH',
      'output_hash informado não confere com a reexecução do motor nesta entrada.',
      'output_hash'
    );
  }

  const passaporte = await buildPassaporteFromDossier({
    holder_org_id: body.holder_org_id.trim(),
    jurisdiction: body.jurisdiction,
    credit_kind: body.credit_kind,
    reference_period: params.reference_period,
    amount_cents: amount,
    closing: body.closing,
    dossier,
  });
  const assinado = await signPassaporte(env, passaporte);
  const pricing = computePricing(amount, passaporte.rating.grade, DEFAULT_I, DEFAULT_T);

  return jsonResponse({ passaporte: assinado, pricing, dossier }, 201);
}
