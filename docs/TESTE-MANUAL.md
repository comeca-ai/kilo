# TESTE-MANUAL — bateria de curl (passaporte-fiscal)

Substitua `$BASE` pela URL do Worker:

```bash
export BASE="http://localhost:8787"   # wrangler dev
# export BASE="https://passaporte-fiscal.<conta>.workers.dev"
```

Pré-requisitos: `wrangler secret put SIGNING_KEY_JWK` (ver RUNBOOK-CHAVE.md) e
`wrangler d1 migrations apply kilo-passaporte --remote`.

## 1. Casos válidos

```bash
# Saúde
curl -s $BASE/api/health
# → 200 {"ok":true,"service":"passaporte-fiscal","ruleset":"BR-SP-CAT42@v2026.09"}

# Chave pública (estável)
curl -s $BASE/api/pubkey
# → 200 {"alg":"Ed25519","public_jwk":{"kty":"OKP","crv":"Ed25519","x":"..."},"ephemeral":false,"note":"Chave estável (secret configurado)."}

# Ruleset (hash deve ser sha256:49878474...f383d7)
curl -s $BASE/api/ruleset | python3 -m json.tool

# Deságio — exemplo de referência do contrato
curl -s "$BASE/api/desagio?vn=2500000&rating=A&i=0.015&T=12"
# → 200 {"inputs":{"amount_cents":250000000,"grade":"A","i":0.015,"T":12},"g":0.01,
#        "fair_value_cents":207005887,"desagio_justo":0.172,
#        "transicao_lc214":{"parcelas":240,"valor_presente_cents":67495554,"perda":0.73}}

# Deságio com defaults (i=0.015, T=12)
curl -s "$BASE/api/desagio?vn=1000000&rating=C"
# → 200 com g=0.12

# Emissão de passaporte (4 documentos → rating A, findings vazio)
curl -s -X POST $BASE/api/passaporte -H 'content-type: application/json' -d '{
  "holder_org_id": "cnpj_12345678000190",
  "state_registration": "110.042.490.114",
  "credit_kind": "ICMS_ACCUMULATED",
  "jurisdiction": "BR-SP",
  "amount_cents": 250000000,
  "reference_period": {"from": "2026-08-01", "to": "2026-08-31"},
  "documents": [
    {"kind": "efd_icms_ipi",   "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000001"},
    {"kind": "nfe_xml",        "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000002"},
    {"kind": "apuracao",       "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000003"},
    {"kind": "livro_registro", "hash": "sha256:0000000000000000000000000000000000000000000000000000000000000004"}
  ]
}' | tee /tmp/psp.json | python3 -m json.tool
# → 201 {"passaporte": {...grade A, completeness 1, findings [], signature...}, "pricing": {...}}

# Verificação — três formas aceitas
python3 -c "import json;print(json.dumps({'passaporte':json.load(open('/tmp/psp.json'))['passaporte']}))" > /tmp/verify.json
curl -s -X POST $BASE/api/verify -H 'content-type: application/json' -d @/tmp/verify.json
# → 200 {"valid":true,"verified_with":"Ed25519 / stable"}

python3 -c "import json;print(json.dumps(json.load(open('/tmp/psp.json'))['passaporte']))" > /tmp/verify-direto.json
curl -s -X POST $BASE/api/verify -H 'content-type: application/json' -d @/tmp/verify-direto.json
# → 200 {"valid":true,...}  (objeto passaporte direto; {"passport": {...}} também funciona)

# Passaporte incompleto (2 docs, sem IE, período ruim → rating C + 3 findings)
curl -s -X POST $BASE/api/passaporte -H 'content-type: application/json' -d '{
  "holder_org_id": "cnpj_999", "amount_cents": 1000,
  "reference_period": {"from": "2026-13-01", "to": "data-ruim"},
  "documents": [{"kind": "efd_icms_ipi", "hash": "sha256:aa"}, {"kind": "nfe_xml", "hash": "sha256:bb"}]
}' | python3 -m json.tool
# → 201 grade C, completeness 0.5, findings: DOC-COMPLETE(critica, missing apuracao+livro_registro),
#   IE-PRESENTE(alta), PERIODO-COERENTE(alta)

# Lead válido
curl -s -X POST $BASE/api/lead -H 'content-type: application/json' -d '{
  "nome": "Maria Silva", "email": "maria@empresa.com.br",
  "empresa": "Empresa LTDA", "valor_credito": 2500000,
  "simulacao": {"grade": "A", "vn": 2500000}
}'
# → 201 {"id":"lead_<26 base32>"}   (confira: wrangler d1 execute kilo-passaporte --remote --command "SELECT * FROM leads")
```

## 2. Casos inválidos da auditoria (comportamento silencioso antigo → agora 400)

```bash
# rating=Z: antes caía silenciosamente em g=0.05 → AGORA 400
curl -s -w '\n%{http_code}\n' "$BASE/api/desagio?vn=2500000&rating=Z"
# → 400 {"error":{"code":"INVALID_RATING","message":"Rating inválido — use A, B ou C.","field":"rating"}}

# i=abc: antes virava null silencioso → AGORA 400
curl -s -w '\n%{http_code}\n' "$BASE/api/desagio?vn=2500000&rating=A&i=abc"
# → 400 {"error":{"code":"INVALID_I",...,"field":"i"}}

# T=-5: fora da faixa → 400
curl -s -w '\n%{http_code}\n' "$BASE/api/desagio?vn=2500000&rating=A&T=-5"
# → 400 {"error":{"code":"INVALID_T",...,"field":"T"}}

# vn=0: antes retornava fair_value_cents null → AGORA 400
curl -s -w '\n%{http_code}\n' "$BASE/api/desagio?vn=0&rating=A"
# → 400 {"error":{"code":"INVALID_VN",...,"field":"vn"}}

# Passaporte sem amount_cents positivo
curl -s -X POST $BASE/api/passaporte -H 'content-type: application/json' \
  -d '{"holder_org_id":"x","amount_cents":0,"documents":[]}'
# → 400 {"error":{"code":"INVALID_AMOUNT",...,"field":"amount_cents"}}

# Passaporte sem holder_org_id
curl -s -X POST $BASE/api/passaporte -H 'content-type: application/json' \
  -d '{"amount_cents":1000,"documents":[]}'
# → 400 INVALID_HOLDER_ORG_ID

# Passaporte sem documents
curl -s -X POST $BASE/api/passaporte -H 'content-type: application/json' \
  -d '{"holder_org_id":"x","amount_cents":1000}'
# → 400 INVALID_DOCUMENTS

# Verify com JSON malformado
curl -s -X POST $BASE/api/verify -H 'content-type: application/json' -d '{quebrado'
# → 400 {"error":{"code":"INVALID_JSON",...}}

# Verify com passaporte adulterado (troque amount_cents e mantenha a assinatura)
python3 -c "
import json
p = json.load(open('/tmp/psp.json'))['passaporte']
p['amount_cents'] = 1
print(json.dumps({'passaporte': p}))" > /tmp/forged.json
curl -s -X POST $BASE/api/verify -H 'content-type: application/json' -d @/tmp/forged.json
# → 200 {"valid":false,"verified_with":"Ed25519 / stable"}

# Lead inválido: nome curto / e-mail ruim
curl -s -X POST $BASE/api/lead -H 'content-type: application/json' -d '{"nome":"A","email":"a@b.com"}'
# → 400 {"error":{"code":"INVALID_LEAD",...,"field":"nome"}}
curl -s -X POST $BASE/api/lead -H 'content-type: application/json' -d '{"nome":"Nome Ok","email":"invalido"}'
# → 400 INVALID_LEAD field=email

# Honeypot: finge sucesso e NÃO grava
curl -s -X POST $BASE/api/lead -H 'content-type: application/json' \
  -d '{"nome":"Bot","email":"bot@x.com","website":"http://spam"}'
# → 201 {"id":"lead_..."}  (verifique que NÃO aparece no SELECT * FROM leads)
```

## 3. Rate limit e CORS

```bash
# Rate limit do /api/lead = 10/min: o 11º request no mesmo minuto → 429
for n in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code} " -X POST $BASE/api/lead \
    -H 'content-type: application/json' -d '{"nome":"Teste Limite","email":"t@l.com"}'
done
# → 201 x10, depois 429 (com header Retry-After; corpo {"error":{"code":"RATE_LIMITED",...,"retry_after":N}})

# Preflight CORS
curl -s -i -X OPTIONS $BASE/api/lead \
  -H "Origin: https://app.exemplo.com" -H "Access-Control-Request-Method: POST" | head -8
# → 204 com Access-Control-Allow-Origin e Access-Control-Allow-Headers: content-type
```

## 4. Degradação sem secret / sem D1

```bash
# Suba um dev sem SIGNING_KEY_JWK:
curl -s $BASE/api/pubkey        # → 503 NO_SIGNING_KEY
curl -s $BASE/api/health        # → 200 (leitura segue OK)
# Sem binding D1 configurado:
curl -s -X POST $BASE/api/lead -H 'content-type: application/json' \
  -d '{"nome":"Sem Banco","email":"s@b.com"}'
# → 503 {"error":{"code":"LEADS_UNAVAILABLE","message":"Captura temporariamente indisponível."}}
```
