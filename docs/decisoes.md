# Decisões

- 2026-09-07: primeira tela pública (`/`) = simulador.
- 2026-09-08: visual do app em `/passaporte` = handoff Kilo (ink `#080B12`, âmbar `#E8B44A`).
- 2026-09-08 (tarde): ordem do produto no app — **A** dossiê/mesa primeiro; **B** simulador e emissão só depois do `POST /api/scan`.
- 2026-09-08 (noite): A passa a extrair e cruzar no cliente (XML, EFD, CSV, strings de PDF/XLSX). B usa o mesmo layout das telas novas (papel + LC 214 + i/T em range). Rating no B sai do motor.
- 2026-09-08 (noite 2): home `/` = tela anexa “Simulador de Deságio ICMS” — duas colunas (premissas / resultado), steppers de i e T, sensibilidade 6/12/24/36m. Job no primeiro viewport. CTA “Abrir o dossiê”.
- PDF/planilha binária não viram livro-razão. Contam como `apuracao` ou `livro_registro` na completude; a ficha mostra só o que apareceu em claro.
- Sem XML ou EFD o botão do motor fica morto. Sem scan o simulador do app não abre número.
