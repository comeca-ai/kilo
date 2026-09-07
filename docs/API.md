# API — passaporte-fiscal (Cloudflare Worker)

Base URL: `https://<seu-worker>.workers.dev` (sem dependências externas; ESM puro, sem build).

Convenções gerais:

- **Erros** seguem sempre o envelope `{"error": {"code": "<SNAKE>", "message": "<pt-BR>", "field": "<campo>"?}}`.
  `field` só existe em erros de validação de um campo específico.
- **JSON canônico**: todas as digests e a assinatura usam `canonicalStringify` — chaves de objetos
  ordenadas recursivamente (por code unit UTF-16), sem espaços, arrays na ordem original, strings
  escapadas como `JSON.stringify`, bytes hasheados em UTF-8. Ver `src/canonical.js`.
- **Rate limit** por IP (`cf-connecting-ip`), janela fixa de 60 s. Estouro →
  `429 {"error":{"code":"RATE_LIMITED","message":"Muitas requisições — tente novamente em instantes.","retry_after": <seg>}}`
  com header `Retry-After`. Store D1 (`rate_limits`); sem o binding, fallback em memória por
  isolate (**aproximado**: cada isolate conta separadamente — ver `src/ratelimit.js`).
- **CORS**: allowlist em `ALLOWED_ORIGINS` (csv, default `"*"`). Preflight `OPTIONS` responde 204
  com `Access-Control-Allow-Headers: content-type`. Em produção, troque `"*"` pelos domínios próprios.
- Erros inesperados → `500 {"error":{"code":"INTERNAL","message":"Erro interno."}}` (sem stacktrace).

| Rota                | Método | Limite  |
| ------------------- | ------ | ------- |
| `/api/health`       | GET    | 120/min |
| `/api/pubkey`       | GET    | 120/min |
| `/api/ruleset`      | GET    | 120/min |
| `/api/closing/checklist` | GET | 120/min |
| `/api/desagio`      | GET    | 60/min  |
| `/api/passaporte`   | POST   | 10/min  |
| `/api/verify`       | POST   | 60/min  |
| `/api/lead`         | POST   | 10/min  |
| `/api/scan`         | POST   | 10/min  |

---

## GET /api/health

```bash
curl https://<worker>/api/health
```

`200`:

```json
{"ok": true, "service": "passaporte-fiscal", "ruleset": "BR-SP-CAT42@v2026.09"}
```

---

## GET /api/pubkey

Chave pública Ed25519 **derivada do secret** `SIGNING_KEY_JWK` (estável, não efêmera).

`200`:

```json
{
  "alg": "Ed25519",
  "public_jwk": {"kty": "OKP", "crv": "Ed25519", "x": "<base64url>"},
  "ephemeral": false,
  "note": "Chave estável (secret configurado)."
}
```

`public_jwk` inclui `kid` quando o JWK privado configurado tem `kid` (o `scripts/genkey.mjs` gera com).

Sem secret configurado → `503 {"error":{"code":"NO_SIGNING_KEY","message":"Chave de assinatura não configurada."}}`.

---

## GET /api/ruleset

`200`:

```json
{
  "ruleset": {
    "rule_id": "BR-SP-CAT42",
    "version": "v2026.09",
    "jurisdiction": "BR-SP",
    "credit_kind": "ICMS_ACCUMULATED",
    "required_docs": ["efd_icms_ipi", "nfe_xml", "apuracao", "livro_registro"],
    "checks": [
      {"id": "DOC-COMPLETE", "desc": "Todos os documentos exigidos pela rota estão presentes"},
      {"id": "PERIODO-COERENTE", "desc": "Competência do EFD bate com o período de referência"},
      {"id": "VALOR-POSITIVO", "desc": "Valor do crédito é positivo e informado em centavos"},
      {"id": "IE-PRESENTE", "desc": "Inscrição estadual do estabelecimento informada"}
    ]
  },
  "ruleset_hash": "sha256:49878474f494a1545a3c3e94a04f4b031e9057d25c5e734fd9fe294e98f383d7"
}
```

> **Nota sobre `ruleset_hash`**: é `SHA-256(hex)` do **JSON canônico** do objeto `ruleset`
> (chaves ordenadas recursivamente, sem espaços). O valor
> `49878474…f383d7` só é reproduzível com essa serialização exata — `JSON.stringify` na ordem de
> declaração, pretty-print ou escape de não-ASCII (`\uXXXX`) produzem hashes diferentes. Ao
> verificar externamente, use o mesmo algoritmo de `src/canonical.js`. O hash muda se qualquer
> campo do ruleset mudar (inclusive textos de `desc`).

---

## GET /api/closing/checklist

Expõe o **checklist de fechamento** (diligência da contraparte) usado na avaliação do campo
`closing` do `/api/passaporte`. É um ruleset à parte, com versão e hash próprios — **não** faz
parte do ruleset fiscal e não altera `ruleset_hash`.

`200`:

```json
{
  "checklist": {
    "checklist_id": "FECHAMENTO",
    "version": "v1",
    "desc": "Documentos de fechamento exigidos pela contraparte (diligência/KYC), independentes da rota fiscal.",
    "itens": [
      {"kind": "cartao_cnpj", "label": "Cartão CNPJ (comprovante de inscrição)", "categoria": "possuido"},
      {"kind": "contrato_social", "label": "Contrato social consolidado", "categoria": "possuido"},
      {"kind": "inscricao_estadual", "label": "Comprovante de Inscrição Estadual (I.E.)", "categoria": "possuido"},
      {"kind": "cnd_estadual", "label": "CND Estadual (certidão negativa de débitos)", "categoria": "possuido"},
      {"kind": "politica_governanca", "label": "Política de governança/compliance", "categoria": "possuido"},
      {"kind": "balanco", "label": "Balanço/balancete (3 últimos meses)", "categoria": "possuido", "min_count": 3},
      {"kind": "nda", "label": "NDA assinado", "categoria": "a_assinar"},
      {"kind": "procuracao", "label": "Procuração", "categoria": "a_assinar"}
    ]
  },
  "checklist_hash": "sha256:<hex64>"
}
```

> `checklist_hash` é o SHA-256 do JSON canônico do checklist (mesmo algoritmo de
> `src/canonical.js`), computado no isolate — reproduzível externamente. Categoria
> `possuido` = documento que a organização já deve ter (ausência → `missing`);
> `a_assinar` = instrumento a assinar no fechamento (ausência → `pending_signature`).

---

## GET /api/desagio

Calcula deságio justo e perda na transição LC 214/2025.

Parâmetros (query):

| Parâmetro | Obrigatório | Regra                                             |
| --------- | ----------- | ------------------------------------------------- |
| `vn`      | sim         | número, `0 < vn ≤ 1e13` (valor de face em reais)  |
| `rating`  | sim         | `A`, `B` ou `C`                                   |
| `i`       | não         | número em `[0, 0.20]` (default `0.015`)           |
| `T`       | não         | inteiro em `[1, 360]` meses (default `12`)        |

```bash
curl 'https://<worker>/api/desagio?vn=2500000&rating=A&i=0.015&T=12'
```

`200`:

```json
{
  "inputs": {"amount_cents": 250000000, "grade": "A", "i": 0.015, "T": 12},
  "g": 0.01,
  "fair_value_cents": 207005887,
  "desagio_justo": 0.172,
  "transicao_lc214": {"parcelas": 240, "valor_presente_cents": 67495554, "perda": 0.73}
}
```

Fórmulas exatas (`g` por rating: `A=0.01, B=0.05, C=0.12`):

```
fair   = vn·(1-g)/(1+i)^T                 → fair_value_cents = Math.round(fair_em_centavos)
desagio_justo = round4(1 - fair/vn)
pv240  = (vn/240)·(1-(1+i)^-240)/i        → valor_presente_cents = Math.round (com i=0, pv240 = vn)
perda  = round4(1 - pv240/vn)
```

Erros de validação (`400`): `INVALID_VN` (vn ausente/não numérico/fora da faixa), `INVALID_RATING`
(rating fora de A/B/C — **inclusive `rating=Z`**, que a versão antiga tratava silenciosamente como
`g=0.05`), `INVALID_I` (ex.: `i=abc`, `i=0.5`), `INVALID_T` (ex.: `T=-5`, `T=2.5`). **Não há mais
fallback silencioso nem `null` em resposta.**

---

## POST /api/passaporte

Emite passaporte fiscal assinado (Ed25519) + pricing calculado com a grade atribuída.

```bash
curl -X POST https://<worker>/api/passaporte \
  -H 'content-type: application/json' \
  -d '{
    "holder_org_id": "cnpj_12345678000190",
    "state_registration": "110.042.490.114",
    "credit_kind": "ICMS_ACCUMULATED",
    "jurisdiction": "BR-SP",
    "amount_cents": 250000000,
    "reference_period": {"from": "2026-08-01", "to": "2026-08-31"},
    "documents": [
      {"kind": "efd_icms_ipi", "hash": "sha256:<hex>"},
      {"kind": "nfe_xml", "hash": "sha256:<hex>"},
      {"kind": "apuracao", "hash": "sha256:<hex>"},
      {"kind": "livro_registro", "hash": "sha256:<hex>"}
    ]
  }'
```

`201`:

```json
{
  "passaporte": {
    "passport_id": "psp_<12hex>",
    "version": 1,
    "issuer": "fiscal-platform",
    "holder_org_id": "cnpj_12345678000190",
    "jurisdiction": "BR-SP",
    "credit_kind": "ICMS_ACCUMULATED",
    "route_candidates": ["SP_ART84_NONINTERDEPENDENT"],
    "reference_period": {"from": "2026-08-01", "to": "2026-08-31"},
    "amount_cents": 250000000,
    "rating": {"grade": "A", "factors": ["completude_documental", "aderencia_layout", "risco_glosa_estimado"]},
    "status_claim": "DOCUMENTED_FOR_REVIEW",
    "completeness": 1,
    "findings": [],
    "evidence_manifest_hash": "sha256:<hex64>",
    "ruleset_hash": "sha256:<hex64>",
    "input_hash": "sha256:<hex64>",
    "consent_id": null,
    "issued_at": "<ISO>",
    "expires_at": "<ISO +30d>",
    "signature": "<base64>"
  },
  "pricing": {
    "inputs": {"amount_cents": 250000000, "grade": "A", "i": 0.015, "T": 12},
    "g": 0.01, "fair_value_cents": 207005887, "desagio_justo": 0.172,
    "transicao_lc214": {"parcelas": 240, "valor_presente_cents": 67495554, "perda": 0.73}
  }
}
```

Regras determinísticas do servidor:

- **Rating**: `completeness = presentes/4` (presentes = docs exigidos cujo `kind` aparece em
  `documents`); grade: 4 docs → `A`, 3 → `B`, ≤2 → `C`. `documents: []` é aceito → grade `C`.
- **Findings** (vazio quando tudo ok):
  - doc exigido ausente → `{"check":"DOC-COMPLETE","severity":"critica","evidence":{"missing":[<kinds>]}}`
  - valor não positivo → `{"check":"VALOR-POSITIVO","severity":"critica"}` (na prática bloqueado pelo 400 abaixo)
  - IE ausente → `{"check":"IE-PRESENTE","severity":"alta"}`
  - `reference_period` malformado → `{"check":"PERIODO-COERENTE","severity":"alta"}`
- **Hashes**: `input_hash` = SHA-256 do JSON canônico do body; `evidence_manifest_hash` = SHA-256 do
  JSON canônico de `{"documents":[...], "holder_org_id", "reference_period"}`; `ruleset_hash` como em
  `/api/ruleset`.
- **Assinatura**: Ed25519 sobre o JSON canônico do passaporte **sem** o campo `signature`, base64 padrão.
- `pricing` usa a grade atribuída, `i=0.015`, `T=12`.

Validações `400`: `INVALID_HOLDER_ORG_ID` (ausente/vazio), `INVALID_AMOUNT` (`amount_cents` ausente,
não inteiro ou ≤ 0), `INVALID_DOCUMENTS` (`documents` ausente ou não-array), `INVALID_CLOSING`
(`closing` presente mas não-array), `INVALID_JSON` (corpo malformado). Sem secret → `503 NO_SIGNING_KEY`.

### Checklist de Fechamento (opcional)

O body aceita o campo opcional `closing`: array de `{"kind": "<kind do checklist>", "competencia": "YYYY-MM"?}`
(campo `competencia` só é relevante para `balanco`). Quando presente, o passaporte ganha o campo
`closing` (logo após `findings`) com a avaliação determinística do checklist de fechamento:

```json
"closing": {
  "version": "FECHAMENTO@v1",
  "checklist_hash": "sha256:<hex64>",
  "completeness": 0.875,
  "present": ["cartao_cnpj", "..."],
  "missing": ["balanco"],
  "pending_signature": ["nda", "procuracao"],
  "details": {"balanco": {"present_count": 2}}
}
```

Regras da avaliação (função pura, sem relógio/aleatoriedade — ver `src/closing.js`):

- `balanco` exige **3 competências distintas** (`competencia` no formato `YYYY-MM`); se nenhum doc
  `balanco` tiver `competencia`, conta-se o número de instâncias. Os demais itens bastam 1 doc do `kind`.
- `missing` lista só itens `possuido` ausentes; `pending_signature` lista itens `a_assinar` ausentes.
- O checklist servido (e o hash) está em `GET /api/closing/checklist`.

> **Nota de produto**: o checklist de fechamento é **diligência da contraparte** e **NÃO altera o
> rating fiscal A/B/C** (nem `ruleset_hash`, `completeness` fiscal ou findings); `nda`/`procuração`
> são instrumentos a assinar — ausência é **pendência, não falha**. Sem o campo `closing` no body,
> o passaporte sai **sem** o campo (retrocompatibilidade byte-a-byte com o contrato anterior).

---

## POST /api/verify

Verifica a assinatura de um passaporte. Aceita três formas de payload:

```bash
curl -X POST https://<worker>/api/verify -H 'content-type: application/json' -d '{"passaporte": {...}}'
curl -X POST https://<worker>/api/verify -H 'content-type: application/json' -d '{"passport": {...}}'
curl -X POST https://<worker>/api/verify -H 'content-type: application/json' -d '{...objeto passaporte direto...}'
```

`200`:

```json
{"valid": true, "verified_with": "Ed25519 / stable"}
```

- `verified_with`: `"Ed25519 / stable"` (chave atual) ou `"Ed25519 / previous"` (chave anterior,
  durante a janela de rotação com `SIGNING_KEY_JWK_PREVIOUS` — ver RUNBOOK-CHAVE.md).
- Payload adulterado → `{"valid": false, ...}` (sempre 200; `valid` carrega o resultado).
- JSON malformado → `400 INVALID_JSON`; payload sem passaporte reconhecível → `400 INVALID_PASSAPORTE`.
- Sem nenhuma chave configurada → `503 NO_SIGNING_KEY`.

---

## POST /api/scan

Scan prévio do **motor determinístico** (`worker/motor/`): o cliente envia os textos
brutos dos documentos fiscais e recebe o dossiê completo — findings dos 6 checks,
rating heurístico v1, completude e a trinca de reprodutibilidade
(`input_hash`, `ruleset.version`, `output_hash`).

> **NÃO é um passaporte**: não há assinatura Ed25519 nem emissão de documento
> atestado. A resposta carrega `status_claim: "SCAN_ONLY_NOT_A_PASSPORT"` para
> deixar isso explícito. Para emissão assinada, use `/api/passaporte`.

Request (corpo JSON, **máx. 2 MB**):

| Campo      | Regra                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| `nfe_xml`  | opcional* — string (1 XML de NF-e, `nfeProc` ou `NFe` pura) **ou** array de strings |
| `efd_text` | opcional* — string com o texto SPED da EFD ICMS/IPI (registros 0000/C100/E110)    |
| `params`   | opcional — objeto passado ao motor: `reference_period {from,to}` (YYYY-MM-DD), `amount_cents`, `state_registration` |

\* Ao menos um de `nfe_xml`/`efd_text` é obrigatório.

```bash
curl -X POST https://<worker>/api/scan \
  -H 'content-type: application/json' \
  -d '{
    "nfe_xml": ["<nfeProc ...>...</nfeProc>"],
    "efd_text": "|0000|015|0|01082026|31082026|...",
    "params": {
      "reference_period": {"from": "2026-08-01", "to": "2026-08-31"},
      "amount_cents": 135000,
      "state_registration": "123456789110"
    }
  }'
```

`200`:

```json
{
  "status_claim": "SCAN_ONLY_NOT_A_PASSPORT",
  "dossier": {
    "ruleset": {"rule_id": "BR-SP-CAT42", "version": "v2026.09"},
    "input_hash": "<sha256 hex>",
    "completude": 0.5,
    "findings": [
      {"check": "DOC-COMPLETE", "severity": "critica",
       "evidence": {"missing": ["apuracao", "livro_registro"]}}
    ],
    "rating": {"grade": "C", "g": 0.12, "detalhe": {"...": "..."}},
    "parsed_resumo": {
      "qtd_nfe": 1, "qtd_c100": 3,
      "periodo_efd": {"dt_ini": "2026-08-01", "dt_fin": "2026-08-31"},
      "skipped": [], "errors": []
    },
    "output_hash": "<sha256 hex>"
  }
}
```

Semântica e garantias:

- **Determinístico**: mesma entrada → mesmo `output_hash`, em qualquer isolate
  (o motor é função pura: sem relógio, sem aleatoriedade; os nomes internos dos
  documentos são gerados deterministicamente e o `sha256` é calculado no ingest
  sobre os bytes UTF-8 recebidos).
- **XML/EFD inválido não derruba o scan**: o erro vai para
  `dossier.parsed_resumo.errors` (`code` `NFE_PARSE_ERROR`/`EFD_PARSE_ERROR`) e a
  resposta segue `200` — o motor nunca inventa dados.
- **Completude/rating são conservadores por construção**: o ruleset exige 4 kinds
  (`efd_icms_ipi`, `nfe_xml`, `apuracao`, `livro_registro`) e este endpoint recebe
  apenas os 2 parseáveis. Logo `completude ≤ 0.5` e o finding `DOC-COMPLETE` sempre
  lista `apuracao`/`livro_registro` como ausentes — a grade resultante tende a `C`.
  É triagem pessimista deliberada, não bug: documentos não parseáveis só entram na
  completude no fluxo de intake completo (ver `docs/INTAKE-MOTOR.md`).
- **Sem `params`**, os checks `VALOR-POSITIVO` (critica) e `IE-PRESENTE` (alta)
  disparam por ausência — comportamento fiel do motor.
- Workers não têm `DOMParser`: o parser de NF-e usa o fallback regex documentado em
  `motor/nfe.js` (o mesmo caminho exercido pelos 23 testes node da suíte).

Erros:

| Código              | HTTP | Quando                                                        |
| ------------------- | ---- | ------------------------------------------------------------- |
| `INVALID_SCAN_INPUT`| 400  | sem `nfe_xml` nem `efd_text`; ou tipo inválido (com `field`)  |
| `INVALID_JSON`      | 400  | corpo vazio ou JSON malformado                                 |
| `PAYLOAD_TOO_LARGE` | 413  | corpo > 2 MB (por Content-Length ou pelo corpo real lido)      |
| `RATE_LIMITED`      | 429  | mais de 10 req/min por IP (+ header `Retry-After`)             |

---

## POST /api/lead

Captura de lead da landing (isca). Persiste em D1 (`leads`, migration `0001_leads.sql`).

```bash
curl -X POST https://<worker>/api/lead \
  -H 'content-type: application/json' \
  -d '{"nome": "Maria Silva", "email": "maria@empresa.com.br", "empresa": "Empresa LTDA",
       "valor_credito": 2500000, "simulacao": {"grade": "A", "vn": 2500000}}'
```

`201`: `{"id": "lead_<26 chars base32 Crockford>"}`

| Campo           | Regra                                                        |
| --------------- | ------------------------------------------------------------ |
| `nome`          | obrigatório, string com ≥ 2 caracteres (após trim)           |
| `email`         | obrigatório, formato `local@dominio.tld`                      |
| `empresa`       | opcional, string                                             |
| `valor_credito` | opcional, número finito ≥ 0 (gravado como REAL)              |
| `simulacao`     | opcional, objeto JSON (gravado como texto serializado)       |
| `website`       | **honeypot**: se preenchido → `201 {"id":"lead_..."}` **sem gravar** |

Erros: `400 INVALID_LEAD` (com `field`), `503 LEADS_UNAVAILABLE` (binding D1 ausente ou falha de
gravação — "Captura temporariamente indisponível."). IP e user-agent são gravados para auditoria.

---

## Códigos de erro

| Código                | HTTP | Onde                                              |
| --------------------- | ---- | ------------------------------------------------- |
| `INVALID_VN`          | 400  | `/api/desagio`                                    |
| `INVALID_RATING`      | 400  | `/api/desagio`                                    |
| `INVALID_I`           | 400  | `/api/desagio`                                    |
| `INVALID_T`           | 400  | `/api/desagio`                                    |
| `INVALID_HOLDER_ORG_ID` | 400 | `/api/passaporte`                                 |
| `INVALID_AMOUNT`      | 400  | `/api/passaporte`                                 |
| `INVALID_DOCUMENTS`   | 400  | `/api/passaporte`                                 |
| `INVALID_CLOSING`     | 400  | `/api/passaporte`                                 |
| `INVALID_PASSAPORTE`  | 400  | `/api/verify`                                     |
| `INVALID_LEAD`        | 400  | `/api/lead`                                       |
| `INVALID_SCAN_INPUT`  | 400  | `/api/scan`                                       |
| `PAYLOAD_TOO_LARGE`   | 413  | `/api/scan` (corpo > 2 MB)                        |
| `INVALID_JSON`        | 400  | todos os POSTs                                    |
| `RATE_LIMITED`        | 429  | todas (+ header `Retry-After`)                    |
| `NO_SIGNING_KEY`      | 503  | `/api/pubkey`, `/api/passaporte`, `/api/verify`   |
| `LEADS_UNAVAILABLE`   | 503  | `/api/lead`                                       |
| `METHOD_NOT_ALLOWED`  | 405  | rota conhecida, método errado                     |
| `NOT_FOUND`           | 404  | rota desconhecida                                 |
| `INTERNAL`            | 500  | catch global (sem stacktrace)                     |
