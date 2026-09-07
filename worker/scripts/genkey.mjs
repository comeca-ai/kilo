// genkey.mjs — gera par de chaves Ed25519 para o Worker (Node 18+, só WebCrypto nativo).
//
// Uso:
//   node scripts/genkey.mjs
//
// Saída: o JWK PRIVADO (para `wrangler secret put SIGNING_KEY_JWK`) e o JWK público
// (para conferência/distribuição — é exatamente o que GET /api/pubkey expõe).
// O JWK privado inclui kid (primeiros 16 hex do SHA-256 de x), útil em rotação.

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

async function sha256Hex(text) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Node 18+ suporta 'Ed25519' na WebCrypto; versões antigas usavam o nome experimental
// 'NODE-ED25519' — tentamos os dois para o script rodar em qualquer Node 18+.
async function generate() {
  try {
    return await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  } catch {
    return await subtle.generateKey({ name: 'NODE-ED25519' }, true, ['sign', 'verify']);
  }
}

const keyPair = await generate();
const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey);

const kid = (await sha256Hex(publicJwk.x)).slice(0, 16);
privateJwk.kid = kid;
publicJwk.kid = kid;

const privateLine = JSON.stringify(privateJwk);

console.log('=== Par Ed25519 gerado ===\n');
console.log('1) Configure o secret no Worker (cole a linha inteira quando pedido):\n');
console.log('   wrangler secret put SIGNING_KEY_JWK\n');
console.log(privateLine + '\n');
console.log('2) Chave PÚBLICA (conferência — deve bater com GET /api/pubkey):\n');
console.log(JSON.stringify(publicJwk, null, 2) + '\n');
console.log('3) Guarde o JWK privado em cofre (1Password/Vault). Nunca commite.');
console.log('   Rotação: ver RUNBOOK-CHAVE.md.');
