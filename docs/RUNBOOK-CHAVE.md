# RUNBOOK — Chave de assinatura Ed25519 (passaporte-fiscal)

O Worker assina passaportes com **Ed25519**. A chave privada vive **somente** no secret
`SIGNING_KEY_JWK` do Worker (JWK privado completo, JSON de uma linha). A pública é derivada do
secret e exposta em `GET /api/pubkey`. Sem secret: `/api/pubkey`, `/api/passaporte` e
`/api/verify` respondem `503 NO_SIGNING_KEY`; os demais GETs seguem funcionando.

## 1. Geração (primeira vez)

Pré-requisito: Node 18+ (usa só WebCrypto nativa).

```bash
node scripts/genkey.mjs
```

O script imprime:

1. a linha do **JWK privado** (com `kid` = 16 hex iniciais do SHA-256 de `x`);
2. o **JWK público** para conferência.

Configure o secret (cole a linha inteira do JWK privado quando o prompt pedir):

```bash
wrangler secret put SIGNING_KEY_JWK
```

Guarde o JWK privado no cofre da empresa (1Password/Vault), em item com acesso restrito
(ver §5). **Nunca** commite o JWK privado nem o coloque em `wrangler.toml`/`[vars]`.

Conferência pós-deploy:

```bash
curl https://<worker>/api/pubkey
# o campo public_jwk.x (e kid, se houver) deve ser idêntico ao impresso pelo genkey
```

## 2. Rotação (janela de dupla verificação)

Objetivo: trocar a chave **sem invalidar** passaportes já emitidos durante a transição.

1. Gere o par novo: `node scripts/genkey.mjs` (guarde no cofre).
2. Promova a chave **atual** para o secret de transição:
   ```bash
   wrangler secret put SIGNING_KEY_JWK_PREVIOUS   # cole o JWK privado ATUAL (antigo)
   ```
3. Suba a chave **nova** como principal:
   ```bash
   wrangler secret put SIGNING_KEY_JWK            # cole o JWK privado NOVO
   ```
4. A partir daí:
   - `/api/passaporte` assina **só com a chave nova**;
   - `/api/verify` aceita assinaturas da chave nova (`verified_with: "Ed25519 / stable"`)
     **e** da anterior (`verified_with: "Ed25519 / previous"`).
5. Monitore: quando pararem de aparecer verificações com `"Ed25519 / previous"` (os logs de
   aplicação/integrações mostram isso) **e** tiver decorrido o prazo máximo de validade útil
   dos passaportes antigos — recomendação: **N = 35 dias** (passaporte expira em 30 dias +
   margem) —, remova a chave anterior:
   ```bash
   wrangler secret delete SIGNING_KEY_JWK_PREVIOUS
   ```
6. Confirme que `GET /api/pubkey` expõe a pública nova e comunique as integrações que fazem
   verificação offline para atualizarem a pública de referência.

> Passaportes assinados com a chave antiga continuam **criptograficamente válidos** até
> `expires_at`; remover `SIGNING_KEY_JWK_PREVIOUS` apenas faz o `/api/verify` passar a
> rejeitá-los. Só remova após o fim da janela combinada com as integrações.

## 3. Revogação / comprometimento

Se a chave privada vazar:

1. **Imediato**: gere par novo e suba como `SIGNING_KEY_JWK` (o atacante deixa de conseguir
   assinar como o emissor a partir desse momento — mas passaportes falsificados assinados com
   a chave vazada ainda verificam, então:)
2. **Não** coloque a chave vazada em `SIGNING_KEY_JWK_PREVIOUS` (diferente da rotação normal).
   Isso faz `/api/verify` rejeitar tudo que foi assinado com ela (`valid: false`).
3. Comunique as integrações: a pública antiga deve ser **removida** das allowlists de
   verificação offline; passaportes emitidos antes do incidente precisam ser **reemitidos**
   (novo `POST /api/passaporte`).
4. Registre o incidente: data/hora, `kid` e `x` da chave revogada, quem executou a troca.

## 4. Verificação offline (com a chave pública)

Qualquer parte pode verificar um passaporte sem chamar o Worker, usando apenas o
`public_jwk` de `GET /api/pubkey` e o mesmo JSON canônico (Node 18+):

```js
// verify-offline.mjs — node verify-offline.mjs passaporte.json
import { readFileSync } from 'node:fs';

function canonicalStringify(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(v[k])).join(',') + '}';
}

const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { signature, ...unsigned } = p;

const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: process.env.PASSAPORTE_PUB_X }; // x do /api/pubkey
const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify']);
const ok = await crypto.subtle.verify(
  { name: 'Ed25519' },
  key,
  Buffer.from(signature, 'base64'),
  new TextEncoder().encode(canonicalStringify(unsigned))
);
console.log(ok ? 'VÁLIDO' : 'INVÁLIDO');
```

Confira também, fora da assinatura: `expires_at` (validade temporal), `ruleset_hash` (versão
do ruleset esperada) e os findings (`status_claim` é apenas um claim — não substitui análise).

## 5. Acesso e guarda

| O quê                                   | Quem tem acesso                          |
| --------------------------------------- | ---------------------------------------- |
| Secret `SIGNING_KEY_JWK` (Wrangler/CF)  | 2 pessoas da plataforma (conta Cloudflare com MFA; papel restrito ao Worker) |
| JWK privado no cofre                    | mesmo grupo, item com auditoria de leitura |
| Chave pública                           | público (via `/api/pubkey`)              |

Boas práticas: rotação programada a cada 12 meses (ou imediata em caso de desligamento de
pessoa com acesso); nunca logar o JWK privado; `wrangler secret put` só a partir de máquina
confiável; revisar trimestralmente quem tem papel de edição de secrets na conta Cloudflare.
