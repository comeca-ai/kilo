# NOTAS — Trilho 1 · Landing "Kilo · Passaporte Fiscal"

Entregável: `index.html` — arquivo único, self-contained, sem build. Abrir direto no navegador.
Todo o conteúdo em PT-BR. Vanilla JS em um único `<script>` no final; única dependência externa
é o Google Fonts (com fallbacks Georgia/serif e mono do sistema — a página funciona offline).

## Decisões tomadas

- **Direção visual (redesign editorial, set/2026):** paleta tinta `#0B0F1A` / creme `#F5EFE0` /
  dourado `#E8B53A` / bronze `#A8690C`; verde `#5BC48A` só para estados de verificado/sucesso.
  Seções alternando tinta↔creme, hairlines de 1px no lugar de sombras e cards arredondados.
- **Tipografia:** Fraunces variável (`opsz 9..144`, `wght 300..700`) como display **e** corpo,
  com `font-optical-sizing:auto`, pesos leves (320–480) e leading generoso (1.72). IBM Plex
  Mono reservado para labels em caixa-alta com letter-spacing, metadados, dados e todos os
  números (`font-variant-numeric:tabular-nums`).
- **Textura:** grão de filme via SVG `feTurbulence` inline (data-URI em `background-image`,
  `opacity:.05`, `mix-blend-mode:overlay`, camada `fixed` com `pointer-events:none`).
- **Motivo do selo:** carimbo circular SVG autoral (borda dupla tracejada, arco
  "PASSAPORTE FISCAL • DOCUMENTED FOR REVIEW •" via `textPath` com `textLength` para fechar
  o círculo, "Ed25519"/"SHA-256" ao centro), rotação −6° como carimbo real. Usado com
  parcimônia: hero (desktop) + CTA final. O lockup da nav/footer usa o mesmo vocabulário
  (quadrado com filete tracejado + K em Fraunces).
- **Estrutura da página:** nav sticky com hairline → hero editorial (headline Fraunces grande,
  sub, CTAs, pílula-contador) → faixa de credenciais em mono (`ED25519 · SHA-256 ·
  DOCUMENTED_FOR_REVIEW · CAT 42/SP · RATING A/B/C · VERIFICÁVEL OFFLINE`) → calculadora +
  lead → banda âmbar de urgência → "O que atesta / O que não atesta" (duas colunas, com o
  bordão "Atesto, não homologo — homologação é da SEFAZ." em pull-quote) → como funciona →
  tabela de rating → FAQ → CTA final com selo → footer discreto.
- **Calculadora como peça central:** card tinta sobre creme com filete interno duplo, números
  grandes em mono dourado (deságio como destaque), ratings A/B/C como **selos circulares
  tracejados** selecionáveis (hover com leve rotação), sliders com track fino de 2px,
  preenchimento âmbar progressivo (variável `--fill` pintada pelo JS nos listeners e no init)
  e thumb dourado. Inputs do lead em estilo editorial (underline hairline, foco bronze).
- **Micro-interações:** reveal on scroll via IntersectionObserver (translateY 20px + fade,
  `cubic-bezier(0.22,1,0.36,1)`, stagger de 70ms entre irmãos `.rv`). O estado oculto só é
  aplicado quando o JS adiciona a classe `fx` ao `<body>` — sem JS, tudo visível. Em
  `prefers-reduced-motion` (ou sem IO) todos os `.rv` recebem `.in` imediatamente e o CSS
  desliga a transição.
- **Layout do hero/simulador:** calculadora em grid 7fr/5fr com o card de lead ao lado em
  telas ≥960px. Abaixo de 960px o card de lead fica oculto até a primeira simulação
  (classe `has-sim` no `<body>`), conforme o brief original.
- **Faixa de urgência:** banda âmbar fina com contador + 1 frase sobre as 240 parcelas.
  Continua sendo o único bloco com âmbar de fundo — decisão consciente para o "alarme".
- **Comparativo da calculadora:** dois blocos separados por hairlines ("Com passaporte" com
  filete verde / "Sem homologar · LC 214") + linha de delta. A fórmula segue exibida em mono
  no rodapé do card, para transparência.
- **FAQ em `<details>` nativo:** funciona sem JS, acessível por teclado, zero custo.
- **Tabela de rating:** `min-width: 540px` dentro de wrapper com `overflow-x:auto` — em
  360px o scroll fica contido na tabela, nunca na página (sem scroll horizontal global).
- **Unidade de `i` na API — RESOLVIDO na revisão (7/set/2026):** a API espera **fração
  decimal** (`i=0.015` = 1,5% a.m.), confirmado contra o Worker em produção. `I_UNIT`
  está em `'decimal'` (a chamada envia `state.i/100`); o payload do lead também grava
  `i` em fração decimal. Não voltar para `'percent'`. O estado interno e o slider
  continuam em % (0,5–3,0) só para exibição.
- **Badge do servidor:** três estados — oculto, "… conferindo no servidor" (após ação do
  usuário) e "✓ conferido pelo servidor" (verde) quando `fair_value_cents` bate com o
  cálculo local (tolerância de ±1 centavo) e `desagio_justo` bate com tolerância 0,05 p.p.
  Debounce de 350ms, `AbortController` + número de sequência contra respostas fora de ordem.
- **Fila offline:** em falha de rede/HTTP no POST do lead, o payload vai para
  `localStorage['kilo_lead_queue']` e o usuário vê o estado de sucesso honesto
  ("Anotamos seu interesse — se não retornarmos em 48h, escreva para pesar@kilo.ia.br").
  A cada carregamento da página, a fila tenta reenviar silenciosamente.
- **Honeypot:** campo `website` escondido com CSS (`.hp`, `aria-hidden`, `tabindex="-1"`).
  Se preenchido, exibe sucesso sem enviar nada.
- **Contador LC 214:** dias até 2033-01-01 (UTC), calculado no carregamento, formatado
  pt-BR ("2.308 dias"), exibido no hero e na faixa de urgência.
- **Formato de números:** BRL sem casas decimais (`Intl.NumberFormat` pt-BR), percentuais
  com 1 casa e vírgula ("17,2%"), taxa "1,5% a.m.".

## O que é placeholder (`data-placeholder="true"`)

- Valor nominal inicial da calculadora: **R$ 2.070.059** (ilustrativo — é o fv derivado do
  default vn = R$ 2.500.000).
- Resultados iniciais da calculadora (derivados do valor acima) e o campo "valor
  aproximado do crédito" do formulário (pré-preenchido com o vn simulado).
- Os percentuais de glosa (1%/5%/12%) **não** são placeholder: são constantes do produto,
  marcadas no texto como heurística.

## Como trocar a URL da API

No `<script>` final, constante no topo:

```js
var API_BASE = 'https://passaporte-fiscal.jhonata-emerick.workers.dev';
```

Usada em: `GET {API_BASE}/api/desagio` (conferência), `POST {API_BASE}/api/lead` (lead) e
reenvio da fila offline. Os links do footer (`/api/desagio · /api/ruleset · /api/pubkey`)
são hrefs absolutos separados — trocar também no HTML do footer se o domínio mudar.

## Validação executada

- `node --check` no script extraído: sintaxe OK. Sem IDs duplicados no HTML; todos os ids
  referenciados pelo JS (`$('...')`) existem no HTML (verificado por grep automatizado).
- Render headless (Chromium/Playwright via `file://`) em 1440px e 390px, full-page: todas as
  seções conferidas visualmente (hero com selo, faixa de credenciais, calculadora tinta,
  banda âmbar, atesta/não-atesta com pull-quote, passos, tabela, FAQ, CTA final, footer);
  sem scroll horizontal no mobile; 35/35 elementos `.rv` revelados após scroll; zero
  pageerrors.
- Teste funcional headless com `fetch` do Worker abortado (offline): clique no rating B,
  sliders i=2,0%/T=24, vn=1.000.000 → resultados recalculados (R$ 590.635 / 40,9% /
  R$ 206.536 / 79,3% — idênticos aos valores de referência anteriores); e-mail inválido
  bloqueia com mensagem; e-mail válido com rede fora → estado de sucesso honesto + payload
  correto na fila do localStorage (`i: 0.02` decimal, `website: ""`); campo do lead
  sincroniza com o vn simulado; gate mobile do card de lead (oculto → visível após simular).
- Releitura completa do arquivo após o redesign, procurando regressões de JS (estado,
  listeners, ordem de respostas do fetch, máscara de dígitos, honeypot, fila offline,
  pintura dos sliders, reveal). Nenhuma lógica de integração foi alterada no redesign.

## Limitações conhecidas

1. **Unidade de `i` não confirmada contra o servidor** (ver decisão acima) — flip de 1 linha.
2. **Máscara do campo de valor** move o cursor para o fim a cada tecla (padrão de máscaras
   simples); aceitável para o caso de uso, mas edição no meio do número é incômoda.
3. **Contador de dias** calculado no carregamento (não atualiza a meia-noite sem reload).
4. **Fila offline** reenvia apenas no próximo carregamento da página (não usa
   Background Sync); em caso de sucesso parcial, os itens com falha permanecem na fila.
5. **Resposta da conferência** é usada só para o badge — a UI não exibe divergências entre
   cálculo local e servidor (por desenho: "se falhar, seguir com cálculo local sem drama").
6. Sem CSP/meta de segurança por ser arquivo único estático; se for servido por um host,
   vale adicionar headers no servidor.
7. **Reveal on scroll** depende de JS para animar (sem JS os elementos aparecem normalmente,
   sem animação — degradação correta); em screenshots full-page headless, a nav sticky pode
   aparecer sobreposta ao meio da captura (artefato da ferramenta, não do layout).
