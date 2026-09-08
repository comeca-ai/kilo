# Regras

- Job 1: organizar e bater o dossiê do cliente (planilha, PDF, balanço, EFD, XML).
- Job 2: simular deságio e emitir, só depois do scan.
- required_docs CAT 42 v1: efd_icms_ipi, nfe_xml, apuracao, livro_registro.
- XML: o cliente lê emit/CNPJ, IE, dhEmi, chNFe, vNF.
- EFD: o cliente lê 0000 (nome, CNPJ, IE, período), C100 (chave e valor) e E110.
- CSV e texto solto: colhe CNPJ, competência, chave de 44 e R$.
- PDF e XLSX binário: hash + strings em claro. Sem parser de layout.
- Bate-volta na mesa: pacote, CNPJ, IE, competência, chaves NF-e×C100, valor (±5%).
- XML e EFD em texto vão para POST /api/scan (limite 2 MB). Sem um dos dois o motor não roda.
- g por rating: A 1%, B 5%, C 12%. Rating do simulador vem do scan, não do slider.
- fair = vn * (1-g) / (1+i)^T
- transição LC 214: PV de 240 parcelas.
- i na API é fração (0.015). Na tela o campo é %.
- Homologação é da SEFAZ. A tela não promete deferimento.
- Registro na bolsa não é transferência fiscal.
