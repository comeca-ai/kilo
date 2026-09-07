// scan.js — POST /api/scan: scan prévio do motor determinístico (motor/).
//
// DIFERENÇA FUNDAMENTAL para /api/passaporte v2: aqui NÃO há assinatura Ed25519
// nem emissão de passaporte. É uma triagem: o cliente envia os textos brutos
// (XML de NF-e e/ou EFD ICMS/IPI) e recebe o dossiê do motor — findings dos
// 6 checks, rating heurístico v1, completude e a trinca de reprodutibilidade
// (input_hash, ruleset version, output_hash). O campo status_claim deixa
// explícito: SCAN_ONLY_NOT_A_PASSPORT.
//
// A montagem dos documentos (montarDocumentosDoBody) é compartilhada com
// POST /api/passaporte v2 — o passaporte reexecuta o mesmo motor sobre a
// mesma entrada; nunca assina um dossiê enviado pelo cliente.
//
// Entrada JSON:
//   {
//     "nfe_xml":  "<xml>" | ["<xml>", ...],   // opcional, string ou array
//     "efd_text": "<sped>",                    // opcional, string
//     "params":   { reference_period, amount_cents, state_registration } // opcional
//   }
// Ao menos um de nfe_xml/efd_text é obrigatório.
//
// Limites: corpo > 2 MB → 413 PAYLOAD_TOO_LARGE. Rate limit (no index.js):
// 10 req/min por IP.
//
// Determinismo: o motor é função pura (sem relógio/aleatoriedade). Os nomes
// dos documentos são gerados deterministicamente (nfe-1.xml, nfe-2.xml, …;
// efd.txt) e o sha256 é calculado aqui sobre os bytes UTF-8 recebidos —
// mesma entrada → mesmo output_hash, em qualquer isolate.
//
// Workers não têm DOMParser: motor/nfe.js tem guarda `typeof DOMParser` e
// cai no parser regex de fallback (mesmo caminho exercitado pelos testes node).

import { executar } from '../motor/engine.js';
import { RULESET } from '../rulesets/br-sp-cat42.v2026.09.js';
import { sha256Hex } from '../motor/canonical.js';
import { jsonResponse, errorResponse, isNonEmptyString } from './validate.js';

export const MAX_SCAN_BODY_BYTES = 2 * 1024 * 1024;

const STATUS_CLAIM = 'SCAN_ONLY_NOT_A_PASSPORT';

export async function handleScan(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_SCAN_BODY_BYTES) {
    return payloadTooLarge();
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'Corpo da requisição ilegível.');
  }
  if (new TextEncoder().encode(text).length > MAX_SCAN_BODY_BYTES) {
    return payloadTooLarge();
  }
  if (!text || !text.trim()) {
    return errorResponse(400, 'INVALID_JSON', 'Corpo JSON ausente ou vazio.');
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, 'INVALID_JSON', 'JSON malformado no corpo da requisição.');
  }

  const montado = await montarDocumentosDoBody(body);
  if (!montado.ok) {
    return errorResponse(400, 'INVALID_SCAN_INPUT', montado.message, montado.field);
  }
  const documents = montado.documents;
  if (documents.length === 0) {
    return errorResponse(
      400,
      'INVALID_SCAN_INPUT',
      'Envie ao menos um documento: nfe_xml e/ou efd_text.'
    );
  }

  const params = extrairParamsDoBody(body);
  const { dossier } = await executar({ documents, ruleset: RULESET, params });
  return jsonResponse({ status_claim: STATUS_CLAIM, dossier }, 200);
}

function payloadTooLarge() {
  return errorResponse(
    413,
    'PAYLOAD_TOO_LARGE',
    'Corpo da requisição excede o limite de 2 MB.'
  );
}

export function validaNfeXml(valor) {
  if (valor === undefined || valor === null) return [];
  const lista = Array.isArray(valor) ? valor : [valor];
  for (const item of lista) {
    if (!isNonEmptyString(item)) return null;
  }
  return lista;
}

const SHA256_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;

function normalizaSha256(valor) {
  if (typeof valor !== 'string') return null;
  const m = valor.trim().match(SHA256_RE);
  return m ? m[1].toLowerCase() : null;
}

export async function montarDocumentosDoBody(body) {
  const nfeLista = validaNfeXml(body && body.nfe_xml);
  if (nfeLista === null) {
    return {
      ok: false,
      field: 'nfe_xml',
      message: 'Campo nfe_xml deve ser uma string XML ou um array de strings XML.',
    };
  }
  if (body && body.efd_text !== undefined && body.efd_text !== null && !isNonEmptyString(body.efd_text)) {
    return {
      ok: false,
      field: 'efd_text',
      message: 'Campo efd_text deve ser uma string não vazia (texto SPED da EFD ICMS/IPI).',
    };
  }

  const documents = [];
  let n = 0;
  for (const xml of nfeLista) {
    n += 1;
    documents.push(await montaDocumento('nfe_xml', `nfe-${n}.xml`, xml));
  }
  if (isNonEmptyString(body && body.efd_text)) {
    documents.push(await montaDocumento('efd_icms_ipi', 'efd.txt', body.efd_text));
  }

  if (body && body.supporting_docs !== undefined && body.supporting_docs !== null) {
    if (!Array.isArray(body.supporting_docs)) {
      return {
        ok: false,
        field: 'supporting_docs',
        message: 'Campo supporting_docs deve ser um array de documentos {kind, name?, sha256?, text?}.',
      };
    }
    let i = 0;
    for (const raw of body.supporting_docs) {
      i += 1;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isNonEmptyString(raw.kind)) {
        return {
          ok: false,
          field: 'supporting_docs',
          message: 'Cada item de supporting_docs precisa de kind (string não vazia).',
        };
      }
      const name = isNonEmptyString(raw.name) ? raw.name.trim() : `${raw.kind}-${i}`;
      if (isNonEmptyString(raw.text)) {
        documents.push(await montaDocumento(raw.kind.trim(), name, raw.text));
        continue;
      }
      const sha = normalizaSha256(raw.sha256);
      if (!sha) {
        return {
          ok: false,
          field: 'supporting_docs',
          message: `supporting_docs[${i - 1}] sem text precisa de sha256 hex de 64 caracteres.`,
        };
      }
      const bytes =
        typeof raw.bytes === 'number' && Number.isInteger(raw.bytes) && raw.bytes >= 0
          ? raw.bytes
          : 0;
      documents.push({
        kind: raw.kind.trim(),
        name,
        bytes,
        sha256: sha,
      });
    }
  }

  return { ok: true, documents };
}

export function extrairParamsDoBody(body) {
  const base =
    body && body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? { ...body.params }
      : {};
  if (base.amount_cents == null && body && body.amount_cents != null) {
    base.amount_cents = body.amount_cents;
  }
  if (base.reference_period == null && body && body.reference_period != null) {
    base.reference_period = body.reference_period;
  }
  if (base.state_registration == null && body && body.state_registration != null) {
    base.state_registration = body.state_registration;
  }
  return base;
}

export async function montaDocumento(kind, name, text) {
  const bytes = new TextEncoder().encode(text);
  return {
    kind,
    name,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    text,
  };
}
