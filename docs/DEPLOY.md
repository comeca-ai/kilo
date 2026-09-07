# DEPLOY — Kilo · Passaporte Fiscal no Cloudflare Workers

Este guia leva uma **conta Cloudflare zerada** ao Worker em produção em ~10 minutos.
O diretório `worker/` é a **unidade deployável**: sobe com 1 comando (`npm run deploy`)
e serve, no mesmo domínio:

- **Landing estática** — arquivos de `worker/public/` servidos como Static Assets
  (`/` → `public/index.html`), direto da borda, sem custo de invocação do Worker;
- **API** — todos os endpoints `/api/*` (contrato em `docs/API.md`), incluindo o
  scan determinístico `POST /api/scan`.

Roteamento (default do Workers Static Assets, sem flags extras): caminho que casa um
arquivo de `public/` → asset servido direto; caminho sem asset correspondente (todo
`/api/*`) → cai no `fetch` do Worker. Referência oficial:
<https://developers.cloudflare.com/workers/static-assets/routing/>

Pré-requisitos locais: **Node.js 18+** (o código usa apenas Web APIs; testes rodam em node puro).

---

## 1. Instalar o wrangler e autenticar

```bash
npm i -g wrangler
wrangler login        # abre o browser para autorizar na sua conta
```

(O `worker/package.json` também traz `wrangler` como devDependency — `npm install`
dentro de `worker/` permite usar `npx wrangler` sem instalação global.)

## 2. Criar o banco D1

```bash
wrangler d1 create kilo-passaporte
```

A saída mostra um bloco com `database_name` e `database_id`. **Copie o `database_id`**
para o `worker/wrangler.toml`, substituindo o placeholder `COLE_AQUI_O_ID`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "kilo-passaporte"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # <- o id do comando acima
```

## 3. Aplicar as migrations

```bash
cd worker
npm run migrate       # = wrangler d1 migrations apply kilo-passaporte --remote
```

Cria as tabelas `leads` (captura da landing) e `rate_limits` (store do rate limit).

## 4. Gerar a chave de assinatura Ed25519

```bash
npm run genkey        # = node scripts/genkey.mjs
```

- O `genkey` imprime o **JWK privado** (uma linha JSON) — guarde-o para o passo 7;
- **Guarde o JWK privado no cofre** da empresa (1Password/Vault). Ele NUNCA vai no
  `wrangler.toml` nem no git;
- Rotação de chave (janela com `SIGNING_KEY_JWK_PREVIOUS`) e revogação:
  `docs/RUNBOOK-CHAVE.md`.

> **Ordem importa (docs oficiais):** o `wrangler secret put` só vem **depois** do
> primeiro `deploy` (passo 7). `secret put` cria uma nova versão do Worker e a
> deploya na hora — num Worker que ainda não existe, falha com erro 10007.

Sem o secret, `/api/pubkey`, `/api/passaporte` e `/api/verify` respondem
`503 NO_SIGNING_KEY`; os demais endpoints funcionam normalmente.

## 5. Ajustar o CORS

Em `worker/wrangler.toml`, `[vars]`:

```toml
ALLOWED_ORIGINS = "https://seudominio.com.br,https://www.seudominio.com.br"
```

O default `"*"` funciona para começar, mas em produção restrinja aos domínios próprios
(origens fora da lista recebem resposta **sem** header CORS — o browser bloqueia).

## 6. Deploy

```bash
cd worker
npm install           # 1ª vez: instala o wrangler local (devDependency)
npm run deploy        # = wrangler deploy
```

Pronto: um comando. A saída mostra a URL `https://kilo-passaporte.<subdomínio>.workers.dev`.

## 7. Gravar o secret de assinatura

Com o Worker já existente (passo 6 feito):

```bash
printf '%s' "$(cat /caminho/para/jwk-privado.txt)" | wrangler secret put SIGNING_KEY_JWK
```

(Use `printf '%s'` em vez de `echo` para não acrescentar `\n` ao valor.)
O `secret put` cria uma nova versão do Worker e a redeploya — não precisa de
`deploy` extra. Rode de novo com `SIGNING_KEY_JWK_PREVIOUS` na janela de rotação
(ver `docs/RUNBOOK-CHAVE.md`).

Dev local (simula Workers + D1 + assets na sua máquina):

```bash
npm run dev           # http://localhost:8787
```

## 8. Verificação pós-deploy

```bash
export BASE="https://kilo-passaporte.<subdomínio>.workers.dev"

# Landing (Static Asset)
curl -s $BASE/ | head -5
# → HTML "Kilo · Passaporte Fiscal"

# Saúde
curl -s $BASE/api/health
# → {"ok":true,"service":"passaporte-fiscal","ruleset":"BR-SP-CAT42@v2026.09"}

# Chave pública (confira que public_jwk.x bate com o impresso pelo genkey)
curl -s $BASE/api/pubkey

# Deságio — exemplo de referência do contrato (docs/API.md)
curl -s "$BASE/api/desagio?vn=2500000&rating=A&i=0.015&T=12"
# → {"inputs":{"amount_cents":250000000,...},"g":0.01,"fair_value_cents":207005887,
#    "desagio_justo":0.172,"transicao_lc214":{...,"perda":0.73}}

# Scan determinístico — NF-e + EFD de exemplo (fixtures sintéticos do repo)
cd worker
node -e '
  const { readFileSync } = require("fs");
  const body = {
    nfe_xml: readFileSync("test/fixtures/nfe/nfe-1.xml", "utf8"),
    efd_text: readFileSync("test/fixtures/efd/efd-a.txt", "utf8"),
    params: {
      reference_period: { from: "2026-08-01", to: "2026-08-31" },
      amount_cents: 135000,
      state_registration: "123456789110"
    }
  };
  require("fs").writeFileSync("/tmp/scan.json", JSON.stringify(body));
'
curl -s -X POST $BASE/api/scan -H 'content-type: application/json' -d @/tmp/scan.json
# → {"status_claim":"SCAN_ONLY_NOT_A_PASSPORT","dossier":{...rating, findings, hashes...}}
#   Rode 2x: o output_hash é IDÊNTICO (motor determinístico).
```

Bateria completa de casos válidos/inválidos: `docs/TESTE-MANUAL.md`.

## Domínio próprio

Com o domínio já na sua conta Cloudflare (zone ativa), adicione ao `wrangler.toml`:

```toml
workers_dev = false   # opcional: desliga a URL *.workers.dev

[[routes]]
pattern = "seudominio.com.br"
custom_domain = true

[[routes]]
pattern = "www.seudominio.com.br"
custom_domain = true
```

e rode `npm run deploy` de novo — o wrangler cria o DNS e o certificado
automaticamente (`custom_domain = true`). Alternativa: painel Cloudflare →
Workers → seu Worker → Settings → Domains & Routes. Depois de apontar o domínio,
**atualize o `ALLOWED_ORIGINS`** (passo 5) e faça redeploy.

## Preview ≠ produção

- `wrangler dev` / `wrangler versions upload` (preview) **não** são produção:
  segredos, D1 e domínio podem apontar para recursos locais/efêmeros. Só considere
  "em produção" o que subiu com `npm run deploy` (`wrangler deploy`).
- Antes de anunciar a URL, refaça a verificação do passo 7 **na URL final**.
- Migrações de D1 têm que ser aplicadas com `--remote` para valer no banco de
  produção (`npm run migrate` já faz isso); `wrangler dev` usa um banco local
  descartável.

## Operação

| Tarefa                          | Comando                                             |
| ------------------------------- | --------------------------------------------------- |
| Logs em tempo real              | `wrangler tail`                                     |
| Consultar leads                 | `wrangler d1 execute kilo-passaporte --remote --command "SELECT * FROM leads ORDER BY created_at DESC LIMIT 20"` |
| Rotacionar chave                | `docs/RUNBOOK-CHAVE.md` §2                          |
| Rodar testes do motor (23)      | `npm test` (node puro, sem wrangler)                |

---

## Opção CI — deploy automático via GitHub Actions (recomendado)

Se o código está no GitHub (`comeca-ai/kilo`), o deploy acontece sozinho a cada push na `main`
via `.github/workflows/deploy.yml`. Configuração uma única vez:

1. **Repo → Settings → Secrets and variables → Actions**, criar:
   - `CLOUDFLARE_API_TOKEN` — em dash.cloudflare.com → My Profile → API Tokens →
     template "Edit Cloudflare Workers" **+ adicionar permissão D1: Edit** na conta
   - `CLOUDFLARE_ACCOUNT_ID` — visível na barra lateral do dashboard (ou em qualquer URL do dash)
   - `SIGNING_KEY_JWK` *(opcional, recomendado)* — a JWK privada Ed25519 gerada com
     `node worker/scripts/genkey.mjs`. Se presente, o workflow grava no Worker sozinho.
     Se ausente, após o primeiro deploy rode uma vez: `cd worker && npx wrangler secret put SIGNING_KEY_JWK`
     (sem ela, `/api/passaporte` responde `503 NO_SIGNING_KEY`).
2. **(Opcional)** Repo → Settings → Variables → Actions: `CF_SUBDOMAIN` = teu subdomain
   workers.dev — usado só no smoke pós-deploy.

O que o workflow faz, em ordem: instala wrangler → **roda os 23 testes do motor (gate)** →
resolve/cria o banco D1 `kilo-passaporte` e injeta o `database_id` no `wrangler.toml` →
aplica as migrations → `wrangler deploy` (Worker +
landing de `worker/public/`) → grava a signing key (se houver — `secret put` redeploya
sozinho) → smoke no `/api/health` com subdomain descoberto via API.

Ou seja: **o primeiro push já deixa tudo no ar** — não precisa rodar os passos manuais
da seção anterior. Os passos manuais continuam valendo para quem quiser deploy direto
da própria máquina, sem CI.
