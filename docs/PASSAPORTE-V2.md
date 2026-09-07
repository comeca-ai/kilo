# Passaporte v2 — nasce do dossiê do motor

O passaporte assinado é o contrato P1→P2. Na v1 ele nascia de uma lista de
`documents[].kind` e o rating era “quantos kinds vieram”. O motor (`/api/scan`)
calculava outro rating. Dois números, um documento com assinatura Ed25519.

Na v2 **só existe um rating**: o `ratingV1` do motor. O Worker **reexecuta**
`executar()` na emissão. Dossiê enviado pelo cliente não é confiável — no
máximo o `output_hash` de um `/api/scan` prévio é conferido.

## Fluxo

```
nfe_xml + efd_text + supporting_docs + params
        → motor.executar()
        → dossier { findings, rating, input_hash, output_hash }
        → passaporte v2 (campos do dossiê + issued_at + signature)
```

`/api/scan` continua sendo triagem (`SCAN_ONLY_NOT_A_PASSPORT`).
`/api/passaporte` é o mesmo motor + ato de emissão (id, validade, Ed25519).

## POST /api/passaporte

```json
{
  "holder_org_id": "cnpj_11222333000181",
  "amount_cents": 135000,
  "reference_period": { "from": "2026-08-01", "to": "2026-08-31" },
  "state_registration": "123456789110",
  "nfe_xml": ["<nfeProc>...</nfeProc>"],
  "efd_text": "|0000|...",
  "supporting_docs": [
    { "kind": "apuracao", "name": "apuracao.pdf", "sha256": "<hex64>", "bytes": 184 },
    { "kind": "livro_registro", "name": "livro.txt", "sha256": "<hex64>", "bytes": 237 }
  ],
  "closing": [{ "kind": "cartao_cnpj" }],
  "output_hash": "<hex do /api/scan, opcional>"
}
```

`amount_cents`, `reference_period` e `state_registration` também podem ir em
`params` (mesmo envelope do scan).

### O que mudou no JSON emitido

| Campo | v1 | v2 |
|---|---|---|
| `version` | `1` | `2` |
| `rating.grade` | kinds presentes / 4 | `dossier.rating.grade` |
| `rating.g` | ausente | `dossier.rating.g` |
| `findings` | 4 checks rasos | 6 checks do motor |
| `completeness` | kinds / 4 | `dossier.completude` |
| `output_hash` | ausente | `sha256:` + hash do dossiê |
| `motor` | ausente | `{ ruleset, input_hash, output_hash, parsed_resumo }` |
| `status_claim` | `DOCUMENTED_FOR_REVIEW` | igual — **nunca** “homologado” |

Checklist `closing` segue opcional e **não** altera o rating fiscal.

### Erros novos

| HTTP | code | Quando |
|---|---|---|
| 400 | `PASSPORT_V1_RETIRED` | body no formato antigo (só `documents[].kind`) |
| 400 | `INVALID_SCAN_INPUT` | sem XML/EFD/supporting_docs, ou tipo errado |
| 409 | `DOSSIER_MISMATCH` | `output_hash` informado ≠ reexecução |

Assinatura e `/api/verify` não mudam: Ed25519 sobre o JSON canônico **sem**
`signature`. Passaportes v1 já emitidos continuam verificáveis.

## O que esta v2 não resolve

- Autenticação obrigatória na emissão (ainda pública + rate limit 10/min).
- Fiação upload → R2 → Queue.
- Parser XML de verdade (Workers ainda usam o fallback regex).
- Layout oficial CAT 42/SP + golden files assinados por revisor fiscal.
