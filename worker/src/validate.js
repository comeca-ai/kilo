// validate.js — resposta de erro uniforme + helpers de validação de entrada.
//
// Formato uniforme de erro (todos os endpoints):
//   4xx/5xx {"error": {"code": "<SNAKE>", "message": "<pt-BR claro>", "field": "<campo>"?}}
// O campo "field" só aparece quando faz sentido (erro de validação de um campo).

export function jsonResponse(body, status = 200, extraHeaders) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(status, code, message, field, extraHeaders) {
  const error = { code, message };
  if (field !== undefined && field !== null) error.field = field;
  return jsonResponse({ error }, status, extraHeaders);
}

function payloadTooLargeResponse() {
  return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Corpo da requisição excede o limite de 2 MB.');
}

// Lê o corpo como JSON. Retorna { ok: true, value } ou { ok: false, response }.
// maxBytes: se informado, corpo maior que o teto → 413 PAYLOAD_TOO_LARGE
// (header Content-Length primeiro, depois o tamanho real UTF-8).
export async function parseJsonBody(request, { maxBytes } = {}) {
  if (maxBytes) {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, response: payloadTooLargeResponse() };
    }
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, 'INVALID_JSON', 'Corpo da requisição ilegível.') };
  }
  if (maxBytes && new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, response: payloadTooLargeResponse() };
  }
  if (!text || !text.trim()) {
    return { ok: false, response: errorResponse(400, 'INVALID_JSON', 'Corpo JSON ausente ou vazio.') };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, 'INVALID_JSON', 'JSON malformado no corpo da requisição.') };
  }
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// E-mail: validação pragmática (formato local@domínio.tld), sem pretensão de RFC 5322 completa.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

// Data "YYYY-MM-DD" válida de verdade (rejeita 2026-02-30, por exemplo).
export function isValidDateString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// reference_period válido: {from, to} com datas válidas e from <= to.
export function isValidReferencePeriod(rp) {
  if (!rp || typeof rp !== 'object' || Array.isArray(rp)) return false;
  if (!isValidDateString(rp.from) || !isValidDateString(rp.to)) return false;
  return rp.from <= rp.to;
}
