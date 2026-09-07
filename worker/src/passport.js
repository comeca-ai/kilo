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

const keyCache = new Map();

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

export function getPublicJwk(env) {
  const jwk = parseSigningJwk(env);
  const pub = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  if (isNonEmptyString(jwk.kid)) pub.kid = jwk.kid;
  return pub;
}

async function getPrivateKey(env) {
  return importKeyCached(env.SIGNING_KEY_JWK, (jwk) => {
    const normalized = { ...jwk };
    delete normalized.alg;
    return crypto.subtle.importKey('jwk', normalized, { name: 'Ed25519' }, false, ['sign']);
  });
}

const pubKeyCache = new Map();

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
const PASSPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PASSPORT_VERSION = 2;

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
    ...(Array.isArray(body.closing) ? { closing: evaluateClosing(body.closing) } : {}),
    evidence_manifest_hash: 'sha256:' + evidenceManifestHash,
    ruleset_hash: RULESET_HASH,
    input_hash: 'sha256:' + inputHash,
    consent_id: null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + PASSPORT_TTL_MS).toISOString(),
  };
}

export async function buildPassaporteFromDossier({
  holder_org_id,
  jurisdiction,
  credit_kind,
  reference_period,
  amount_cents,
  closing,
  dossier,
}) {
  if (!dossier || typeof dossier !== 'object' || !dossier.output_hash || !dossier.rating) {
    throw new Error('buildPassaporteFromDossier: dossier do motor inválido');
  }

  const now = Date.now();
  const grade = dossier.rating.grade;

  return {
    passport_id: 'psp_' + randomHex(12),
    version: PASSPORT_VERSION,
    issuer: ISSUER,
    holder_org_id,
    jurisdiction: jurisdiction || RULESET.jurisdiction,
    credit_kind: credit_kind || RULESET.credit_kind,
    route_candidates: [...ROUTE_CANDIDATES],
    reference_period,
    amount_cents,
    rating: {
      grade,
      g: dossier.rating.g,
      factors: [...RATING_FACTORS],
      detalhe: dossier.rating.detalhe,
    },
    status_claim: 'DOCUMENTED_FOR_REVIEW',
    completeness: dossier.completude,
    findings: dossier.findings,
    ...(Array.isArray(closing) ? { closing: evaluateClosing(closing) } : {}),
    motor: {
      ruleset: dossier.ruleset,
      input_hash: dossier.input_hash,
      output_hash: dossier.output_hash,
      parsed_resumo: dossier.parsed_resumo,
    },
    evidence_manifest_hash: 'sha256:' + dossier.input_hash,
    ruleset_hash: RULESET_HASH,
    input_hash: 'sha256:' + dossier.input_hash,
    output_hash: 'sha256:' + dossier.output_hash,
    consent_id: null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + PASSPORT_TTL_MS).toISOString(),
  };
}

export async function signPassaporte(env, passaporte) {
  const key = await getPrivateKey(env);
  const payload = new TextEncoder().encode(canonicalStringify(passaporte));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payload);
  return { ...passaporte, signature: bytesToBase64(new Uint8Array(sig)) };
}

export function extractPassaporte(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.passaporte && typeof body.passaporte === 'object') return body.passaporte;
  if (body.passport && typeof body.passport === 'object') return body.passport;
  if (typeof body.passport_id === 'string' && typeof body.signature === 'string') return body;
  return null;
}

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
      // chave mal configurada: tenta a próxima
    }
  }
  return { valid: false, verifiedWith: candidates.length > 0 ? candidates[0].label : null };
}
