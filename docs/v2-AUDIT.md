# Auditoria v2 — comeca-ai/kilo (Passaporte Fiscal)

**Draft.** PR ≠ deploy. `main`/live só mudam com merge + Action de deploy e ok explícito.

Escopo desta rodada (v2 shipper): Worker / CI / secrets / motor / Cloudflare.
Front (landing/demo): coordenado com AppleFront — commits de UI podem entrar nesta branch ou PR irmão.

## Findings

### P0 — nenhum bloqueante novo no código auditado
Signing key só via `wrangler secret`; erros 500 não vazam stack; honeypot de lead OK; passaporte v2 reexecuta motor server-side; teto 2 MB em scan/emit.

### P1
| ID | Achado | Evidência | Mitigação nesta PR |
|----|--------|-----------|--------------------|
| P1-1 | `ALLOWED_ORIGINS=*` abre CORS a qualquer origem | `worker/wrangler.toml` `[vars]` | Allowlist `kilo.ia.br` + localhost |
| P1-2 | HTML estático sem headers de endurecimento | `worker/public/` | `worker/public/_headers` |
| P1-3 | Deploy automático em **todo** push `main` | `.github/workflows/deploy.yml` | Mantido (produto); documentado risco + checklist. PR CI paste-me em `docs/ci-pr.yml.paste-me` |
| P1-4 | Register com mesmo teto do login (10/min) | `worker/src/index.js` `RATE_LIMITS` | Register → 5/min |

### P2
| ID | Achado | Evidência | Mitigação |
|----|--------|-----------|-----------|
| P2-1 | Sem `minify` / smart placement | `wrangler.toml` | `minify = true` + `[placement] mode = "smart"` |
| P2-2 | `compatibility_date` antigo (2025-09-01) | `wrangler.toml` | `2026-09-07` |
| P2-3 | Rate limit D1 = 2 round-trips (INSERT + SELECT) | `ratelimit.js` | `RETURNING count` numa query |
| P2-4 | Landing ~63 KB single-file no Worker assets | `worker/public/index.html` | Front com AppleFront (CWV/split) |
| P2-5 | `session_token` também no JSON (além do cookie HttpOnly) | `auth` handlers | Intencional p/ Bearer; risco XSS se front inseguro — não mudar intent |
| P2-6 | Intake R2/Queue ainda não fiado | README / docs | Fora de escopo desta PR |
| P2-7 | D1 sem RLS nativo; auth filtra por sessão | `authdb.js` | OK p/ v1; documentar |

## Wins aplicados (esta PR)
1. Wrangler: minify, smart placement, compatibility_date, CORS allowlist
2. `_headers` em static assets
3. Security headers também nas respostas `/api/*`
4. Rate-limit register 5/min; D1 rate limit com `RETURNING`
5. Este audit + paste-me de CI de PR (token pode carecer scope `workflow`)

## Riscos / o que NÃO mudou
- Produto/intent do motor e contrato do passaporte v2
- Auto-deploy na `main` (continua; gate = testes do motor no workflow)
- Domínio `kilo.ia.br` / `SIGNING_KEY_JWK`
- Homologação SEFAZ (continua fora — Kilo atesta, não homologa)

## Review
```bash
cd worker && npm test && npx wrangler deploy --dry-run
```
