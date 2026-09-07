/**
 * canonical.js — JSON canônico + SHA-256 hex.
 *
 * O motor de regras é uma FUNÇÃO PURA: (documentos, ruleset_version) → dossiê.
 * Para que dois hashes (input_hash / output_hash) sejam comparáveis entre
 * execuções, precisamos de uma serialização JSON DETERMINÍSTICA:
 *
 *   - chaves de objetos ordenadas lexicograficamente (recursivamente);
 *   - sem espaços/indentação;
 *   - arrays preservam a ordem (ordem é significativa);
 *   - undefined em objetos é omitido (comportamento idêntico ao JSON.stringify);
 *   - números não-finitos viram null (idêntico ao JSON.stringify).
 *
 * Não usamos Map/Set aqui: o motor só trafega tipos JSON-serializáveis.
 */

/**
 * Serializa um valor em JSON canônico (chaves ordenadas, sem espaços).
 * @param {*} value valor JSON-serializável
 * @returns {string}
 */
export function canonicalStringify(value) {
  return serialize(value);
}

function serialize(value) {
  if (value === null) return 'null';

  const tipo = typeof value;

  if (tipo === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (tipo === 'boolean') return value ? 'true' : 'false';
  if (tipo === 'string') return JSON.stringify(value);
  if (tipo === 'undefined') return undefined; // tratado pelo chamador

  if (Array.isArray(value)) {
    const itens = value.map((item) => {
      const s = serialize(item);
      // JSON.stringify coloca null onde haveria undefined em arrays
      return s === undefined ? 'null' : s;
    });
    return '[' + itens.join(',') + ']';
  }

  if (tipo === 'object') {
    const chaves = Object.keys(value).sort();
    const pares = [];
    for (const chave of chaves) {
      const s = serialize(value[chave]);
      // JSON.stringify omite propriedades undefined — mantemos o mesmo comportamento
      if (s === undefined) continue;
      pares.push(JSON.stringify(chave) + ':' + s);
    }
    return '{' + pares.join(',') + '}';
  }

  throw new Error(
    `canonicalStringify: tipo não suportado (${tipo}). ` +
      'O motor só aceita tipos JSON-serializáveis.'
  );
}

/**
 * Converte ArrayBuffer/Uint8Array para string hexadecimal minúscula.
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string}
 */
function toHex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 em hexadecimal (64 chars minúsculos).
 *
 * Funciona em Cloudflare Workers (crypto.subtle global) e em Node.js 18+
 * (globalThis.crypto disponível desde o Node 15; estável no 18).
 *
 * @param {string|ArrayBuffer|Uint8Array} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error(
      'sha256Hex: Web Crypto (crypto.subtle) indisponível. ' +
        'Use Node.js 18+ ou um runtime compatível com Workers.'
    );
  }
  let dados;
  if (typeof input === 'string') {
    dados = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    dados = input;
  } else {
    throw new Error('sha256Hex: entrada deve ser string, ArrayBuffer ou Uint8Array.');
  }
  const digest = await subtle.digest('SHA-256', dados);
  return toHex(digest);
}
