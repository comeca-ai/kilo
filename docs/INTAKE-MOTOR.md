# INTAKE-MOTOR — Trilho 3: Motor de Regras Determinístico

Motor que transforma documentos fiscais reais (XML de NF-e e EFD ICMS/IPI em
texto SPED) em **achados reproduzíveis + rating**, substituindo os checks de
mentira da demo. JavaScript ESM puro, **zero dependências**, compatível com
**Cloudflare Workers** e **Node.js 18+** (usa apenas Web Crypto para SHA-256).

## 1. Princípio central: função pura

O motor é uma **FUNÇÃO PURA**:

```
(documentos, ruleset_version) → dossiê
```

Toda execução registra a trinca de reprodutibilidade:

| Campo | O que é |
|---|---|
| `input_hash` | SHA-256 do JSON canônico de `{files (sha256+bytes de cada doc, ordenados por kind/name), ruleset (id+versão+hash), params}` |
| `ruleset.version` | Versão imutável do ruleset (ex.: `v2026.09`) |
| `output_hash` | SHA-256 do dossiê canônico **sem** o próprio campo `output_hash` |

Qualquer auditor reexecuta `executar()` com os mesmos documentos, params e
ruleset e chega **byte a byte** ao mesmo `output_hash` — há teste de
reprodutibilidade na suíte que prova isso (inclusive com a ordem dos
documentos invertida).

**Garantias de determinismo dentro do motor:**

- Nada de `Date.now()`, `Math.random()` ou relógio — datas entram como
  parâmetro (`params.reference_period`).
- Nenhum `Map`/`Set` vaza para a saída (só uso interno, com saída ordenada).
- JSON canônico = `stringify` com chaves ordenadas recursivamente, sem
  espaços (`motor/canonical.js`).
- Manifesto ordenado por `(kind, name, sha256)`; findings ordenados por
  `(check, evidence canônica)`; `skipped`/`errors` ordenados por nome.

## 2. Arquitetura de intake (visão de ponta a ponta)

```
upload → R2 (bytes originais + SHA-256 calculado no ingest)
       → Queue (mensagem com {r2_keys, sha256s, params})
       → Worker consumer → MOTOR (este pacote)
       → D1 (índice: input_hash, ruleset_version, output_hash, rating, qtd_findings)
       → dossiê JSON (R2/ KV) para auditoria e reexecução
```

1. **Upload**: o Worker de ingest grava os bytes originais no R2 e calcula o
   SHA-256 no momento do upload (`sha256` que entra no manifesto). O motor
   nunca recalcula hash de bytes diferentes dos que foram ingeridos — a
   trinca só é válida se o hash vier do ingest.
2. **Queue**: desacopla ingestão de processamento; a mensagem carrega as
   referências dos arquivos e os `params` (período de referência,
   `amount_cents`, `state_registration`).
3. **Motor**: o consumer baixa os textos dos documentos parseáveis
   (`nfe_xml`, `efd_icms_ipi`) e chama `executar()` (ver §5).
4. **D1 (índice)**: grava `(input_hash, ruleset_version, output_hash,
   rating, g, qtd_findings, created_at)`. Idempotência natural: mesma
   entrada → mesmo `output_hash` (dedupe por hash).
5. **Dossiê**: o JSON completo (canônico) é persistido para exibição e
   reexecução auditável.

## 3. Estrutura do pacote

```
motor/
  canonical.js  canonicalStringify + sha256Hex (Web Crypto: Workers e Node 18+)
  nfe.js        parseNFe(xmlText) — DOMParser quando existe; fallback regex
                robusto e comentado em Node (sem dependências)
  efd.js        parseEFD(spedText) — registros 0000 / C100 / E110
  checks.js     6 checks puros + ordenação determinística de findings
  rating.js     ratingV1 (heurístico — ver disclaimer)
  manifest.js   buildManifest(docs) + buildOutputHash(dossier)
  engine.js     executar({documents, ruleset, params}) → {dossier}
rulesets/
  br-sp-cat42.v2026.09.js  ruleset imutável (deepFreeze) + ruleset_hash
test/
  run.test.mjs             suíte node:test (23 testes)
  fixtures/                golden files 100% SINTÉTICOS (ver §6)
```

## 4. Contrato do dossiê

```jsonc
{
  "ruleset": { "rule_id": "BR-SP-CAT42", "version": "v2026.09" },
  "input_hash": "<sha256 hex>",
  "completude": 0.75,                 // required_docs presentes / exigidos
  "findings": [
    { "check": "DOC-COMPLETE", "severity": "critica",
      "evidence": { "missing": ["livro_registro"] } }
  ],
  "rating": { "grade": "B", "g": 0.05, "detalhe": { "...": "..." } },
  "parsed_resumo": {
    "qtd_nfe": 3, "qtd_c100": 3,
    "periodo_efd": { "dt_ini": "2026-08-01", "dt_fin": "2026-08-31" },
    "skipped": [], "errors": []
  },
  "output_hash": "<sha256 hex>"
}
```

Documentos com `kind` `nfe_xml` trazem `text` (XML); `efd_icms_ipi` traz
`text` (SPED); **demais kinds só entram na completude**. Documento parseável
sem `text` → parse pulado com nota em `parsed_resumo.skipped` (**o motor
nunca inventa dados**). Erro de parse não derruba a execução: vai para
`parsed_resumo.errors` (o check de completude já cobre o doc como presente;
a ausência de dados parseados reflete nos checks fiscais).

## 5. Como o Worker chama o motor

> **Hoje**: o motor está exposto via HTTP em `POST /api/scan`
> (`worker/src/scan.js`) — scan prévio **sem assinatura** (ver `docs/API.md`).
> A fiação completa upload→R2→Queue→D1 abaixo segue como próximo passo (§7).

Import relativo puro (sem bundler, sem npm):

```js
// worker/consumer.js (Cloudflare Workers, módulo ESM)
import { executar } from '../track3-intake-motor/motor/engine.js';
import { RULESET } from '../track3-intake-motor/rulesets/br-sp-cat42.v2026.09.js';

export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { docs, params } = msg.body;      // docs: [{kind, name, r2_key, sha256}]
      const documents = [];
      for (const d of docs) {
        const obj = await env.R2_FISCAL.get(d.r2_key);
        if (!obj) continue;
        const doc = {
          kind: d.kind,
          name: d.name,
          bytes: d.bytes ?? obj.size,
          sha256: d.sha256,                    // hash calculado no upload
        };
        if (d.kind === 'nfe_xml' || d.kind === 'efd_icms_ipi') {
          doc.text = await obj.text();         // só kinds parseáveis
        }
        documents.push(doc);
      }
      const { dossier } = await executar({ documents, ruleset: RULESET, params });
      await env.D1.prepare(
        'INSERT OR IGNORE INTO dossies (input_hash, ruleset_version, output_hash, grade, g, qtd_findings, payload) VALUES (?,?,?,?,?,?,?)'
      ).bind(
        dossier.input_hash, dossier.ruleset.version, dossier.output_hash,
        dossier.rating.grade, dossier.rating.g, dossier.findings.length,
        JSON.stringify(dossier)
      ).run();
      msg.ack();
    }
  },
};
```

## 6. Golden files (NUNCA dados reais)

Todos os fixtures são **sintéticos**: empresa fictícia *Indústria Sintética
Ltda*, CNPJ fictício `11.222.333/0001-81`, chaves de 44 dígitos fictícias
(DV não oficial), competência `2026-08`.

| Caso | Documentos | Esperado |
|---|---|---|
| **A** | efd-a + 3 NF-e + apuracao + livro_registro (coerente) | rating **A**, 0 findings, completude 1.0 |
| **B** | idem A, **sem livro_registro** | rating **B**, 1 finding (`DOC-COMPLETE`), completude 0.75 |
| **C** | efd-c (período 2025, só 1 das 3 chaves) + NF-e duplicada divergente (`nfe-3-dup.xml`) | rating **C**, 4 findings (`DOC-COMPLETE`, `PERIODO-COERENTE`, `VAL-006`, `VAL-012`) |

Rodar a suíte:

```bash
node --test test/run.test.mjs    # 23 testes — 23 pass / 0 fail (Node 20)
```

## 7. O que ESTÁ implementado × o que FALTA (layout oficial CAT 42/SP)

### Implementado (motor v1)

- Intake determinístico com trinca `(input_hash, ruleset_version, output_hash)`.
- Parsers mínimos e robustos de NF-e (nfeProc e NFe pura) e EFD ICMS/IPI
  (registros `0000`, `C100`, `E110`), com índices documentados no código
  apontando o Guia Prático EFD.
- 6 checks: `DOC-COMPLETE`, `PERIODO-COERENTE`, `VAL-012-NFE-AUSENTE-EFD`,
  `VAL-006-CHAVE-DUPLICADA`, `VALOR-POSITIVO`, `IE-PRESENTE`.
- Rating v1 com `g` por grade e **refinamento deliberado** da fórmula
  literal: o rebaixamento por critica **ignora `DOC-COMPLETE`** — documento
  faltante já é penalizado na completude; contá-lo de novo seria dupla
  penalização (aprovado pelo lead; sem isso o caso B → B seria impossível).
- Estrutura de ruleset imutável, versionada, com `ruleset_hash` — pronta
  para receber novos checks/docs sem quebrar dossiês antigos.

### FALTA para conformidade com a CAT 42/SP (não usar em produção sem isto)

1. **Revisão fiscal especializada**: a lista `required_docs`
   (`efd_icms_ipi`, `nfe_xml`, `apuracao`, `livro_registro`) e os 6 checks
   são um recorte estrutural. A CAT 42/SP e a documentação da
   DRTC/Sefaz-SP precisam ser confrontadas por **revisor fiscal** para
   fechar a lista documental exata (ex.: inventários, CIAP/CIAP-e,
   demonstrativos de crédito acumulado, DAREs, cartas de correção etc.).
2. **Golden files assinados**: os casos A/B/C são sintéticos e unilaterais.
   É preciso um conjunto de golden files **assinados pelo revisor fiscal**
   (hash do ruleset + hash esperado do dossiê) versionados junto ao ruleset.
   A estrutura já comporta: cada versão nova de ruleset é um arquivo novo
   com `ruleset_hash` próprio, e o teste de reprodutibilidade valida a
   trinca.
3. **Validação de DV da chave de acesso** (módulo 11) e de CNPJ — hoje o
   motor só valida formato (44 dígitos), não o dígito verificador.
4. **Cruzamentos fiscais mais profundos**: CST/CFOP por item (C170),
   apuração detalhada (E110 × E111 ajustes), GIA/SP, confronto EFD × XML
   por valor (hoje o confronto é por chave), tolerâncias de arredondamento.
5. **Persistência real**: a arquitetura R2/Queue/D1 está especificada (§2),
   mas o código de Worker/bindings não faz parte deste trilho.
6. **Rating v2**: `g` e limites são heurísticos arbitrários de triagem;
   qualquer calibração exige base histórica e nova versão de ruleset.

## 8. Limitações honestas

- **Rating é heurístico de triagem (v1), não parecer fiscal/contábil/
  jurídico.** O disclaimer vai em `rating.detalhe.disclaimer` em todo dossiê.
- O parser de NF-e **não valida assinatura XMLDSig** nem consulta Sefaz —
  uma chave presente no XML não prova autorização de uso. O check
  `VAL-006` detecta duplicidade divergente, não fraude sofisticada.
- O fallback regex de NF-e (Node sem DOMParser) assume a gramática do
  layout 4.00; não é um parser XML completo (documentado em `motor/nfe.js`).
- O parser de EFD lê apenas `0000`/`C100`/`E110`; blocos D, G, H, K e os
  registros analíticos (C170, C190, E111...) são ignorados.
- Apenas **1 EFD por execução**; uma segunda EFD vai para `skipped`
  (decisão explícita em vez de escolha arbitrária).
- `parsed_resumo.skipped`/`errors` significam "dados indisponíveis", nunca
  dados sintetizados — o motor **não inventa dados** em nenhuma hipótese.
- Sem fuso/relógio: comparações de data são lexicográficas em `YYYY-MM-DD`;
  `params.reference_period` é responsabilidade do chamador.
