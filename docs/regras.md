# Regras

- Job 1: organizar e bater o dossiê do cliente (planilha, PDF, balanço, EFD, XML).
- Job 2: simular deságio e emitir, só depois do scan.
- required_docs CAT 42 v1: efd_icms_ipi, nfe_xml, apuracao, livro_registro.
- PDF e planilha entram na completude pelo tipo; o motor não parseia esses bytes.
- XML e EFD vão para POST /api/scan (limite 2 MB).
- g por rating: A 1%, B 5%, C 12%.
- fair = vn * (1-g) / (1+i)^T
- transição LC 214: PV de 240 parcelas.
- i na API é fração (0.015). Na tela o campo é %.
- Homologação é da SEFAZ. A tela não promete deferimento.
- Registro na bolsa não é transferência fiscal.
