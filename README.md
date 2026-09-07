# Kilo · Passaporte Fiscal

## Publicar no GitHub (comeca-ai/kilo)

O repo já vem com histórico git pronto (branch `main`). São 3 comandos:

```bash
git remote add origin https://github.com/comeca-ai/kilo.git
git push -u origin main
```

Se baixou via `kilo-repo.bundle`: `git clone kilo-repo.bundle kilo && cd kilo`, ajuste o remote com `git remote set-url origin https://github.com/comeca-ai/kilo.git` e push.


## Rodar no Cloudflare (≈10 min)

O diretório **`worker/` é a unidade deployável**: um único comando (`npm run deploy`)
sobe a API `/api/*` **e** a landing estática (servida de `worker/public/` como
Static Assets — `/` → `public/index.html`, sem custo de invocação do Worker).
Inclui o motor determinístico exposto em `POST /api/scan`.

```bash
wrangler login
wrangler d1 create kilo-passaporte          # colar o database_id no worker/wrangler.toml
cd worker
npm install && npm run migrate && npm run genkey
wrangler secret put SIGNING_KEY_JWK         # colar o JWK privado impresso pelo genkey
npm run deploy
```

Passo a passo completo (conta zerada → produção, verificação pós-deploy, domínio
próprio): **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

Monorepo do produto **Passaporte Fiscal** (P1) — atesto documental de créditos acumulados de
ICMS (BR-SP, rota CAT 42/SP) com rating A/B/C e assinatura Ed25519 — e, futuramente, da
**Rede de Créditos** (P2). Uma plataforma que **prepara e atesta — nunca homologa**: a
homologação é da SEFAZ.

> Documentos-fonte: Especificação v1.0 (decisão-mestre), Plano Fase 0, Arquitetura de
> referência. Este scaffold consolida o que até aqui existia apenas como demo exportada
> (HTML) + Worker sem código versionado.

## Estrutura

```
repo/
├── apps/
│   ├── passaporte/        # Demo funcional atual (single-file HTML, formato .dc.html)
│   │                      # Simulador → Emissão → Passaporte → Verificar → Carteira
│   └── kilo/
│       └── landing/       # Landing pública + calculadora-isca + captura de lead
├── worker/                # UNIDADE DEPLOYÁVEL (Cloudflare Workers) — ver docs/DEPLOY.md
│   ├── src/               # Endpoints /api/* (contrato em docs/API.md), incl. /api/scan
│   ├── public/            # Landing servida como Static Assets (placeholder → integração)
│   ├── motor/             # Motor de regras determinístico (XML/EFD → achados → rating)
│   ├── rulesets/          # Rulesets imutáveis versionados (BR-SP-CAT42 v2026.09)
│   ├── migrations/        # D1: leads, rate_limits
│   ├── wrangler.toml      # config real de deploy (database_id é o único segredo local)
│   └── scripts/           # genkey.mjs (par Ed25519)
├── docs/                  # Contratos, runbooks, decisões
└── DECISAO-MARCA.md       # Kilo × Passaporte Fiscal — decisão provisória
```

## Os três trilhos deste pacote

| Trilho | Entrega | Diretório |
|--------|---------|-----------|
| 1 · Landing + captura de lead | Página pública com a calculadora validada + POST /api/lead | `apps/kilo/landing/` |
| 2 · API hardening | Worker completo versionado: validação 400, rate limit, /api/lead, runbook da chave | `worker/src/` + `docs/` |
| 3 · Intake real + motor | Motor determinístico: parse NF-e/EFD, 6 checks reais, rating v1, manifestos SHA-256, testes golden | `worker/motor/` + `worker/rulesets/` |

## Princípios (da spec)

- **Evidência reproduzível** — toda validação registra `(input_hash, ruleset_version, output_hash)`;
  qualquer auditor reexecuta e chega ao mesmo dossiê.
- **Ruleset imutável e versionado** — publicar exige fonte, vigência, owner, revisor e golden
  files assinados.
- **O Passaporte é o único contrato P1→P2** — JSON canônico + manifesto de evidências +
  assinatura da plataforma; verificável offline. `status_claim` nunca é "homologado".
- **Rating é heurístico** — sempre com disclaimer; não é parecer nem garantia.

## Deploy (resumo)

Ver a seção **"Rodar no Cloudflare (≈10 min)"** no topo e o passo a passo completo em
[`docs/DEPLOY.md`](docs/DEPLOY.md).

Detalhes: `docs/API.md` (contrato, incl. `/api/scan`), `docs/RUNBOOK-CHAVE.md`
(rotação/revogação), `docs/INTAKE-MOTOR.md` (fiação R2/Queues/D1 e o que falta do
layout oficial CAT 42/SP), `docs/TESTE-MANUAL.md` (bateria de curl).

## Estado honesto

- A demo (`apps/passaporte`) **funciona hoje** contra o Worker em produção.
- O intake de documentos **ainda é simulado na demo** — o motor real está em `worker/motor/`
  com testes, mas a fiação upload→R2→Queue→motor é o próximo passo de implementação.
- Layout oficial CAT 42/SP: checks genéricos implementados; validações específicas da rota
  aguardam revisor fiscal + golden files assinados (disciplina da própria spec).
- Gate 0 jurídico: fora do código — continua sendo o kill-risk do P2.
