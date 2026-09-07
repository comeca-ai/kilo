// scan.js — POST /api/scan: scan prévio do motor determinístico (motor/).
//
// DIFERENÇA FUNDAMENTAL para /api/passaporte: aqui NÃO há assinatura Ed25519
// nem emissão de passaporte. É uma triagem: o cliente envia os textos brutos
// (XML de NF-e e/ou EFD ICMS/IPI) e recebe o dossiê do motor — findings dos
// 6 checks, rating heurístico v1, completude e a trinca de reprodutibilidade
// (input_hash, ruleset version, output_hash). O campo status_claim deixa
// explícito: SCAN_ONLY_NOT_A_PASSPORT.
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
// cai no parser regex de fallback (mesmo caminho exercido pelos testes node).

import { executar } from '../motor/engine.js';
import { RULESET } from '../rulesets/br-sp-cat42.v2026.09.js';
import { sha256Hex } from '../motor/canonical.js';
import { jsonResponse, errorResponse, isNonEmptyString } from './validate.js';

// Teto do corpo da requisição: 2 MB (cabe muitas NF-e + EFD de meses).
export const MAX_SCAN_BODY_BYTES = 2 * 1024 * 1024;

const STATUS_CLAIM = 'SCAN_ONLY_NOT_A_PASSPORT';

export async function handleScan(request) {
  // 1) Tamanho: recusa cedo via Content-Length (quando presente)…
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_SCAN_BODY_BYTES) {
    return payloadTooLarge();
  }

  // 2) …e confirma no corpo real lido (Content-Length pode estar ausente/errado).
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

  // 3) Validação da entrada: ao menos um documento, tipos corretos.
  const nfeLista = validaNfeXml(body && body.nfe_xml);
  if (nfeLista === null) {
    return errorResponse(
      400,
      'INVALID_SCAN_INPUT',
      'Campo nfe_xml deve ser uma string XML ou um array de strings XML.',
      'nfe_xml'
    );
  }
  if (body && body.efd_text !== undefined && body.efd_text !== null && !isNonEmptyString(body.efd_text)) {
    return errorResponse(
      400,
      'INVALID_SCAN_INPUT',
      'Campo efd_text deve ser uma string não vazia (texto SPED da EFD ICMS/IPI).',
      'efd_text'
    );
  }
  if (nfeLista.length === 0 && !isNonEmptyString(body && body.efd_text)) {
    return errorResponse(
      400,
      'INVALID_SCAN_INPUT',
      'Envie ao menos um documento: nfe_xml e/ou efd_text.'
    );
  }

  // 4) Monta os documentos no contrato do intake (kind/name/bytes/sha256/text).
  const documents = [];
  let n = 0;
  for (const xml of nfeLista) {
    n += 1;
    documents.push(await montaDocumento('nfe_xml', `nfe-${n}.xml`, xml));
  }
  if (isNonEmptyString(body.efd_text)) {
    documents.push(await montaDocumento('efd_icms_ipi', 'efd.txt', body.efd_text));
  }

  // 5) params opcionais: passados ao motor tal qual (datas entram por aqui —
  //    o motor nunca lê o relógio). Sem params, os checks VALOR-POSITIVO e
  //    IE-PRESENTE disparam por ausência — comportamento fiel do motor.
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? body.params
      : {};

  // 6) Executa o motor (função pura). Erros de parse NÃO derrubam: vão para
  //    dossier.parsed_resumo.errors.
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

// Aceita string (1 NF-e) ou array de strings (n NF-e). Retorna [] quando o
// campo está ausente, null quando o tipo é inválido.
function validaNfeXml(valor) {
  if (valor === undefined || valor === null) return [];
  const lista = Array.isArray(valor) ? valor : [valor];
  for (const item of lista) {
    if (!isNonEmptyString(item)) return null;
  }
  return lista;
}

// Documento no formato do intake do motor, com sha256 dos bytes UTF-8 do texto.
async function montaDocumento(kind, name, text) {
  const bytes = new TextEncoder().encode(text);
  return {
    kind,
    name,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    text,
  };
}
