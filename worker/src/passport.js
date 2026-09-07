// passport.js — construção, assinatura e verificação do passaporte fiscal.
//
// Chave Ed25519:
//   - secret em env.SIGNING_KEY_JWK (JWK privado completo, serializado como JSON);
//   - chave pública é DERIVADA do secret (campos kty/crv/x [+ kid opcional]);
//   - env.SIGNING_KEY_JWK_PREVIOUS (opcional) mantém a chave anterior aceita no /api/verify
//     durante a janela de rotação (ver RUNBOOK-CHAVE.md).
//
// Assinatura: Ed25519 sobre o JSON CANÔNICO do passaporte SEM o campo "signature".
// Verificação offline reproduz o mesmo procedimento (há snippet no RUNBOOK-CHAVE.md).

import {
  canonicalStringify,
  sha256HexCanonical,
  bytesToBase64,
  base64ToBytes,
  randomHex,
} from './canonical.js';
import { RULESET, RULESET_HASH } from './ruleset.js';
import { evaluateClosing } from './closing.js';
import { isNonEmptyString, isValidReferencePeriod } from './validate.js';

// Cache de chaves importadas por isolate (importKey é relativamente caro; o JWK não muda em runtime).
const keyCache = new Map(); // rawJwkString -> Promise<CryptoKey>

function importKeyCached(raw, importFn) {
  let p = keyCache.get(raw);
  if (!p) {
    p = importFn(JSON.parse(raw));
    keyCache.set(raw, p);
  }
  return p;
}

export function hasSigningKey(env) {
  return isNonEmptyString(env.SIGNING_KEY_JWK);
}

function parseSigningJwk(env) {
  const jwk = JSON.parse(env.SIGNING_KEY_JWK);
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) {
    throw new Error('SIGNING_KEY_JWK não é um JWK Ed25519 privado válido');
  }
  return jwk;
}

// JWK público derivado do secret (só campos públicos; kid propagado se existir).
export function getPublicJwk(env) {
  const jwk = parseSigningJwk(env);
  const pub = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  if (isNonEmptyString(jwk.kid)) pub.kid = jwk.kid;
  return pub;
}

async function getPrivateKey(env) {
  return importKeyCached(env.SIGNING_KEY_JWK, (jwk) => {
    // Workers exige JWA estrito: para Ed25519 o campo "alg" do JWK deve ser "EdDSA"
    // (valor registrado na IANA). Chaves geradas com alg="Ed25519" (Node aceita)
    // falham com DataError no importKey. Como o algoritmo já é passado no parâmetro
    // do importKey, removemos "alg" — normalização aceita em ambos os runtimes.
    const normalized = { ...jwk };
    delete normalized.alg;
    return crypto.subtle.importKey('jwk', normalized, { name: 'Ed25519' }, false, ['sign']);
  });
}

// Cache separado para chaves públicas: a chave do Map não é JSON, então não dá para
// reusar importKeyCached (que faz JSON.parse da chave de cache).
const pubKeyCache = new Map(); // cacheKey -> Promise<CryptoKey>

async function getPublicKeyFromRaw(raw) {
  const jwk = JSON.parse(raw);
  const pub = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  if (isNonEmptyString(jwk.kid)) pub.kid = jwk.kid;
  const cacheKey = 'pub:' + (jwk.kid || '') + ':' + jwk.x;
  let p = pubKeyCache.get(cacheKey);
  if (!p) {
    p = crypto.subtle.importKey('jwk', pub, { name: 'Ed25519' }, false, ['verify']);
    pubKeyCache.set(cacheKey, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Rating determinístico a partir dos documentos recebidos:
//   completeness = presentes/4; grade = 4 docs -> A, 3 -> B, <=2 -> C.
// ---------------------------------------------------------------------------
const RATING_FACTORS = Object.freeze([
  'completude_documental',
  'aderencia_layout',
  'risco_glosa_estimado',
]);

function computeRating(documents) {
  const presentKinds = new Set();
  for (const d of documents) {
    if (d && typeof d === 'object' && isNonEmptyString(d.kind)) presentKinds.add(d.kind);
  }
  const missing = RULESET.required_docs.filter((k) => !presentKinds.has(k));
  const present = RULESET.required_docs.length - missing.length;
  const completeness = present / RULESET.required_docs.length;
  const grade = present >= 4 ? 'A' : present === 3 ? 'B' : 'C';
  return { grade, completeness, missing };
}

// Findings do contrato: doc ausente (crítica), valor não positivo (crítica),
// IE ausente (alta), reference_period malformado (alta). Vazio quando tudo ok.
function computeFindings(body, missing) {
  const findings = [];
  if (missing.length > 0) {
    findings.push({ check: 'DOC-COMPLETE', severity: 'critica', evidence: { missing } });
  }
  if (!(typeof body.amount_cents === 'number' && Number.isFinite(body.amount_cents) && body.amount_cents > 0)) {
    findings.push({ check: 'VALOR-POSITIVO', severity: 'critica' });
  }
  if (!isNonEmptyString(body.state_registration)) {
    findings.push({ check: 'IE-PRESENTE', severity: 'alta' });
  }
  if (!isValidReferencePeriod(body.reference_period)) {
    findings.push({ check: 'PERIODO-COERENTE', severity: 'alta' });
  }
  return findings;
}

const ISSUER = 'fiscal-platform';
const ROUTE_CANDIDATES = Object.freeze(['SP_ART84_NONINTERDEPENDENT']);
const PASSPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // expira em +30d

// Monta o objeto passaporte (sem assinatura). A validação 400 dos campos obrigatórios
// acontece ANTES, no handler — aqui os campos já estão saneados.
export async function buildPassaporte(body) {
  const documents = body.documents;
  const { grade, completeness, missing } = computeRating(documents);
  const findings = computeFindings(body, missing);

  const now = Date.now();
  const inputHash = await sha256HexCanonical(body);
  const evidenceManifestHash = await sha256HexCanonical({
    documents,
    holder_org_id: body.holder_org_id,
    reference_period: body.reference_period,
  });

  // Ordem dos campos reproduz o contrato observado em produção (a assinatura usa o
  // JSON canônico, então a ordem aqui é apenas cosmética/compatibilidade de leitura).
  return {
    passport_id: 'psp_' + randomHex(12),
    version: 1,
    issuer: ISSUER,
    holder_org_id: body.holder_org_id,
    jurisdiction: body.jurisdiction || RULESET.jurisdiction,
    credit_kind: body.credit_kind || RULESET.credit_kind,
    route_candidates: [...ROUTE_CANDIDATES],
    reference_period: body.reference_period,
    amount_cents: body.amount_cents,
    rating: { grade, factors: [...RATING_FACTORS] },
    status_claim: 'DOCUMENTED_FOR_REVIEW',
    completeness,
    findings,
    // Checklist de fechamento (diligência da contraparte, ver src/closing.js): só entra
    // quando body.closing é array — sem o campo, o passaporte fica byte-a-byte igual
    // ao contrato anterior (retrocompatibilidade de hash/assinatura). NÃO altera rating
    // nem ruleset_hash. Posição cosmética: logo após findings.
    ...(Array.isArray(body.closing) ? { closing: evaluateClosing(body.closing) } : {}),
    evidence_manifest_hash: 'sha256:' + evidenceManifestHash,
    ruleset_hash: RULESET_HASH,
    input_hash: 'sha256:' + inputHash,
    consent_id: null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + PASSPORT_TTL_MS).toISOString(),
  };
}

// Assina o passaporte: retorna o objeto completo com "signature" (base64 padrão).
export async function signPassaporte(env, passaporte) {
  const key = await getPrivateKey(env);
  const payload = new TextEncoder().encode(canonicalStringify(passaporte));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payload);
  return { ...passaporte, signature: bytesToBase64(new Uint8Array(sig)) };
}

// Extrai o objeto passaporte das três formas aceitas pelo contrato:
// {"passaporte": {...}} | {"passport": {...}} | o objeto passaporte direto.
export function extractPassaporte(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.passaporte && typeof body.passaporte === 'object') return body.passaporte;
  if (body.passport && typeof body.passport === 'object') return body.passport;
  if (typeof body.passport_id === 'string' && typeof body.signature === 'string') return body;
  return null;
}

// Verifica a assinatura. Retorna { valid, verifiedWith }.
// Tenta a chave atual ("Ed25519 / stable") e, se configurada, a anterior
// ("Ed25519 / previous") — janela de rotação, ver RUNBOOK-CHAVE.md.
export async function verifyPassaporte(env, passaporte) {
  if (!passaporte || typeof passaporte !== 'object' || !isNonEmptyString(passaporte.signature)) {
    return { valid: false, verifiedWith: null };
  }
  let sigBytes;
  try {
    sigBytes = base64ToBytes(passaporte.signature);
  } catch {
    return { valid: false, verifiedWith: null };
  }
  const unsigned = { ...passaporte };
  delete unsigned.signature;
  const payload = new TextEncoder().encode(canonicalStringify(unsigned));

  const candidates = [];
  if (hasSigningKey(env)) candidates.push({ raw: env.SIGNING_KEY_JWK, label: 'Ed25519 / stable' });
  if (isNonEmptyString(env.SIGNING_KEY_JWK_PREVIOUS)) {
    candidates.push({ raw: env.SIGNING_KEY_JWK_PREVIOUS, label: 'Ed25519 / previous' });
  }

  for (const c of candidates) {
    try {
      const pub = await getPublicKeyFromRaw(c.raw);
      const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sigBytes, payload);
      if (ok) return { valid: true, verifiedWith: c.label };
    } catch {
      // Chave mal configurada não deve derrubar a verificação: tenta a próxima.
    }
  }
  return { valid: false, verifiedWith: candidates.length > 0 ? candidates[0].label : null };
}
