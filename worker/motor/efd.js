/**
 * efd.js — parser mínimo e determinístico de EFD ICMS/IPI (texto SPED).
 *
 * Extrai somente o que os checks do motor consomem:
 *
 *   {
 *     periodo:  { dt_ini, dt_fin },            // registro 0000
 *     cnpj_declarante,                          // registro 0000 (CNPJ)
 *     notas:    [ { chave, numero, serie, data_doc, valor_doc,
 *                   ind_oper, ind_emit } ],     // registros C100
 *     apuracao: { vl_tot_debitos, vl_sld_devedor,
 *                 vl_sld_credor_at } | null,    // registro E110
 *     totais:   { qtd_c100, soma_vl_doc }
 *   }
 *
 * Índices de campo adotados (contando o campo REG como índice 0):
 *
 *   Registro 0000 (abertura) — Guia Prático EFD-ICMS/IPI:
 *     |0000|COD_VER|COD_FIN|DT_INI|DT_FIN|NOME|CNPJ|CPF|UF|IE|...
 *       0      1       2      3      4    5    6
 *     → DT_INI = índice 3, DT_FIN = índice 4, NOME = 5, CNPJ = 6.
 *     OBSERVAÇÃO: o briefing do motor citou CNPJ no índice 7 contando a
 *     partir de REG=0, o que corresponderia a CPF. Adotamos o índice 6
 *     (guia prático oficial); se o campo 6 estiver vazio, não inventamos
 *     valor — cnpj_declarante fica null.
 *
 *   Registro C100 (nota fiscal modelo 01/55/65) — Guia Prático EFD-ICMS/IPI:
 *     |C100|IND_OPER|IND_EMIT|COD_PART|COD_MOD|COD_SIT|SER|NUM_DOC|CHV_NFE|
 *          DT_DOC|DT_E_S|VL_DOC|IND_PGTO|VL_DESC|VL_ABAT_NT|VL_MERC|...
 *       0      1       2        3        4       5    6     7       8
 *       9     10      11
 *     → IND_OPER=1, IND_EMIT=2, COD_PART=3, COD_MOD=4, COD_SIT=5,
 *       SER=6, NUM_DOC=7, CHV_NFE=8, DT_DOC=9, DT_E_S=10, VL_DOC=11.
 *     CHV_NFE pode vir vazio (notas em papel/modelo antigo) — nesse caso
 *     a nota entra com chave=null e NÃO participa dos checks por chave.
 *
 *   Registro E110 (apuração do ICMS — período) — Guia Prático EFD-ICMS/IPI
 *   (numeração oficial de campos; entre colchetes o índice no array com
 *   REG = 0):
 *     |E110|VL_TOT_DEBITOS|VL_AJ_DEBITOS|VL_TOT_AJ_DEBITOS|VL_ESTORNOS_CRED|
 *          VL_TOT_CREDITOS|VL_AJ_CREDITOS|VL_TOT_AJ_CREDITOS|
 *          VL_ESTORNOS_DEB|VL_SLD_CREDOR_ANT|VL_SLD_APURADO|VL_TOT_DED|
 *          VL_ICMS_RECOLHER|VL_SLD_CREDOR_TRANSPORTAR|DEB_ESP|
 *       campo 02 [1]  VL_TOT_DEBITOS
 *       campo 10 [9]  VL_SLD_CREDOR_ANT
 *       campo 11 [10] VL_SLD_APURADO   (saldo devedor apurado no período)
 *       campo 12 [11] VL_TOT_DED
 *       campo 13 [12] VL_ICMS_RECOLHER
 *       campo 14 [13] VL_SLD_CREDOR_TRANSPORTAR (saldo credor p/ período
 *                     seguinte — o "crédito acumulado" que interessa à CAT42)
 *     → vl_tot_debitos  = índice 1  (VL_TOT_DEBITOS)
 *       vl_sld_devedor  = índice 10 (VL_SLD_APURADO)
 *       vl_sld_credor_at = índice 13 (VL_SLD_CREDOR_TRANSPORTAR)
 *
 * Números SPED usam vírgula decimal — normalizamos para Number.
 */

function erroParse(mensagem) {
  const err = new Error(`parseEFD: ${mensagem}`);
  err.code = 'EFD_PARSE_ERROR';
  return err;
}

/** "1.234,56" → 1234.56 ; "0,00" → 0 ; vazio → null */
function toNumSped(texto) {
  if (texto === undefined || texto === null) return null;
  const t = String(texto).trim();
  if (t === '') return null;
  const normalizado = t.replace(/\./g, '').replace(',', '.');
  const n = Number(normalizado);
  if (!Number.isFinite(n)) {
    throw erroParse(`valor numérico SPED inválido: "${texto}"`);
  }
  return n;
}

/** Valida formato DDMMAAAA e retorna { dia, mes, ano } ou lança erro. */
function validaDDMMAAAA(campo, valor) {
  const m = String(valor || '').match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!m) {
    throw erroParse(
      `registro 0000: ${campo}="${valor}" fora do formato DDMMAAAA.`
    );
  }
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) {
    throw erroParse(`registro 0000: ${campo}="${valor}" é uma data impossível.`);
  }
  return { dia, mes, ano };
}

/** "DDMMAAAA" → "AAAA-MM-DD" (ISO, para comparação determinística). */
function paraISO({ dia, mes, ano }) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${ano}-${p2(mes)}-${p2(dia)}`;
}

/**
 * Faz o parse de um arquivo EFD ICMS/IPI em texto SPED.
 * @param {string} spedText
 */
export function parseEFD(spedText) {
  if (typeof spedText !== 'string' || spedText.trim() === '') {
    throw erroParse('entrada vazia ou não é string.');
  }

  // Linhas em branco são ignoradas; SPED usa \r\n ou \n.
  const linhas = spedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  let reg0000 = null;
  let regE110 = null;
  const notas = [];

  for (const linha of linhas) {
    if (!linha.startsWith('|')) continue; // tolera lixo fora do padrão pipe
    // Remove pipe inicial/final e separa os campos. REG fica no índice 0.
    let campos = linha.split('|');
    if (campos.length > 0 && campos[0] === '') campos = campos.slice(1);
    if (campos.length > 0 && campos[campos.length - 1] === '') campos = campos.slice(0, -1);
    const reg = campos[0];

    if (reg === '0000') {
      if (reg0000) throw erroParse('mais de um registro 0000 no arquivo.');
      reg0000 = campos;
    } else if (reg === 'C100') {
      if (campos.length < 12) {
        throw erroParse(`registro C100 com campos insuficientes: "${linha}"`);
      }
      const chaveBruta = (campos[8] || '').trim();
      notas.push({
        chave: /^\d{44}$/.test(chaveBruta) ? chaveBruta : null,
        numero: (campos[7] || '').trim() || null,
        serie: (campos[6] || '').trim() || null,
        data_doc: validaOuNuloDDMMAAAA(campos[9], linha),
        valor_doc: toNumSped(campos[11]),
        ind_oper: (campos[1] || '').trim() || null,
        ind_emit: (campos[2] || '').trim() || null,
      });
    } else if (reg === 'E110') {
      if (regE110) throw erroParse('mais de um registro E110 no arquivo.');
      regE110 = campos;
    }
  }

  if (!reg0000) {
    throw erroParse('registro 0000 (abertura) ausente — não é uma EFD válida.');
  }

  // 0000: REG(0) COD_VER(1) COD_FIN(2) DT_INI(3) DT_FIN(4) NOME(5) CNPJ(6)
  if (reg0000.length < 7) {
    throw erroParse('registro 0000 com campos insuficientes.');
  }
  const dtIni = validaDDMMAAAA('DT_INI', reg0000[3]);
  const dtFin = validaDDMMAAAA('DT_FIN', reg0000[4]);

  let apuracao = null;
  if (regE110) {
    // Precisamos até o índice 13 (VL_SLD_CREDOR_TRANSPORTAR); o campo 15
    // (DEB_ESP, índice 14) é opcional e não é lido pelo motor.
    if (regE110.length < 14) {
      throw erroParse('registro E110 com campos insuficientes.');
    }
    apuracao = {
      vl_tot_debitos: toNumSped(regE110[1]),
      vl_sld_devedor: toNumSped(regE110[10]),
      vl_sld_credor_at: toNumSped(regE110[13]),
    };
  }

  // Soma determinística: percorre as notas na ordem do arquivo.
  let soma = 0;
  for (const n of notas) {
    soma += n.valor_doc || 0;
  }
  // Arredonda para 2 casas para evitar ruído de ponto flutuante no hash.
  const soma_vl_doc = Math.round(soma * 100) / 100;

  return {
    periodo: { dt_ini: paraISO(dtIni), dt_fin: paraISO(dtFin) },
    cnpj_declarante: (reg0000[6] || '').trim() || null,
    notas,
    apuracao,
    totais: { qtd_c100: notas.length, soma_vl_doc },
  };
}

/** DT_DOC da C100: aceita DDMMAAAA; vazio → null; inválido → erro. */
function validaOuNuloDDMMAAAA(valor, linha) {
  const t = String(valor || '').trim();
  if (t === '') return null;
  try {
    return paraISO(validaDDMMAAAA('DT_DOC', t));
  } catch {
    throw erroParse(`registro C100 com DT_DOC inválido: "${linha}"`);
  }
}
