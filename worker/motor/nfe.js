/**
 * nfe.js — parser mínimo e determinístico de XML de NF-e (layout 4.00).
 *
 * Extrai somente os campos que os checks do motor consomem:
 *   { chave, numero, serie, data_emissao, emitente_cnpj, destinatario_cnpj,
 *     valor_bc_icms, valor_icms, valor_total }
 *
 * Aceita tanto <nfeProc> (NF-e + protocolo de autorização) quanto <NFe> pura.
 *
 * Chave de acesso (44 dígitos):
 *   1) atributo Id de <infNFe> no formato "NFe" + 44 dígitos (caminho principal);
 *   2) fallback: elemento <chNFe> (presente, por exemplo, em
 *      nfeProc/protNFe/infProt/chNFe) com 44 dígitos.
 *
 * Estratégia de parsing:
 *   - Se existir DOMParser global (browsers): parsing XML de verdade, com
 *     detecção de <parsererror>.
 *   - Caso contrário (Cloudflare Workers e Node.js puro, que NÃO têm
 *     DOMParser global): parsing por regex
 *     ROBUSTO e comentado, com saneamento de prefixos de namespace e
 *     verificação mínima de estrutura. O fallback não é um parser XML
 *     completo — ele valida os blocos que consome e lança erro descritivo
 *     quando a estrutura esperada não está presente.
 */

/** Erro descritivo padronizado do parser. */
function erroParse(mensagem) {
  const err = new Error(`parseNFe: ${mensagem}`);
  err.code = 'NFE_PARSE_ERROR';
  return err;
}

/** Converte texto numérico fiscal ("123.45") em Number; vazio → null. */
function toNum(texto) {
  if (texto === undefined || texto === null || texto === '') return null;
  const n = Number(texto);
  if (!Number.isFinite(n)) {
    throw erroParse(`valor numérico inválido: "${texto}"`);
  }
  return n;
}

/** Extrai apenas a data (YYYY-MM-DD) de um dhEmi ISO (pode vir com hora/fuso). */
function extraiData(dhEmi) {
  if (!dhEmi) return null;
  const m = String(dhEmi).match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) {
    throw erroParse(`data de emissão inválida: "${dhEmi}"`);
  }
  return m[1];
}

/* --------------------------------------------------------------------------
 * Caminho 1: DOMParser (browsers — Workers/Node caem no Caminho 2)
 * ------------------------------------------------------------------------ */

function parseComDOM(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  // DOMParser não lança exceção em XML malformado: insere <parsererror>.
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    throw erroParse(
      'XML malformado (DOMParser): ' +
        String(parserError.textContent || '').slice(0, 200)
    );
  }

  // Busca por localName, ignorando prefixo de namespace.
  const porLocal = (nome) => {
    const todos = doc.getElementsByTagName('*');
    for (let i = 0; i < todos.length; i++) {
      if (todos[i].localName === nome) return todos[i];
    }
    return null;
  };
  const filhoPorLocal = (pai, nome) => {
    if (!pai) return null;
    for (const filho of pai.childNodes) {
      if (filho.nodeType === 1 && filho.localName === nome) return filho;
    }
    return null;
  };
  const textoDe = (pai, nome) => {
    const el = filhoPorLocal(pai, nome);
    return el ? el.textContent.trim() : null;
  };

  const infNFe = porLocal('infNFe');
  if (!infNFe) {
    throw erroParse('elemento <infNFe> não encontrado — não é um XML de NF-e.');
  }

  const chave = extraiChaveDoId(infNFe.getAttribute('Id')) || extraiChNFe((porLocal('infProt') && textoDe(porLocal('infProt'), 'chNFe')) || textoDe(doc.documentElement, 'chNFe'));

  const ide = filhoPorLocal(infNFe, 'ide');
  const emit = porLocal('emit');
  const dest = porLocal('dest');
  const icmsTot = porLocal('ICMSTot');
  if (!ide || !emit || !icmsTot) {
    throw erroParse('blocos obrigatórios ausentes (ide/emit/ICMSTot).');
  }

  return montaResultado({
    chave,
    numero: textoDe(ide, 'nNF'),
    serie: textoDe(ide, 'serie'),
    data_emissao: textoDe(ide, 'dhEmi') || textoDe(ide, 'dEmi'),
    emitente_cnpj: textoDe(emit, 'CNPJ'),
    destinatario_cnpj: dest ? textoDe(dest, 'CNPJ') : null,
    valor_bc_icms: textoDe(icmsTot, 'vBC'),
    valor_icms: textoDe(icmsTot, 'vICMS'),
    valor_total: textoDe(icmsTot, 'vNF'),
  });
}

/* --------------------------------------------------------------------------
 * Caminho 2 (fallback Node sem dependências): regex robusto e comentado
 * ------------------------------------------------------------------------
 * Limitações assumidas de propósito:
 *   - Não é um parser XML completo; assume a gramática do layout NF-e 4.00.
 *   - Todos os blocos extraídos são delimitados por tag de abertura/fechamento
 *     com o MESMO nome, então aninhamento idêntico (ex.: <emit> dentro de
 *     <emit>) não ocorre no layout oficial e quebraria aqui.
 *   - Prefixos de namespace opcionais são tolerados (ex.: <nfe:ide>).
 * ------------------------------------------------------------------------ */

/** Casa um bloco <tag>...</tag> (com prefixo de namespace opcional). */
function bloco(xml, tag) {
  const re = new RegExp(
    '<(?:\\w+:)?' + tag + '\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>',
    'i'
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Casa o conteúdo textual de uma tag simples <tag>valor</tag>. */
function tagTexto(xml, tag) {
  const re = new RegExp(
    '<(?:\\w+:)?' + tag + '\\b[^>]*>([^<]*)</(?:\\w+:)?' + tag + '>',
    'i'
  );
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Chave a partir do atributo Id de <infNFe Id="NFe3526..."> (44 dígitos). */
function extraiChaveDoId(idAttr) {
  if (!idAttr) return null;
  const m = String(idAttr).trim().match(/^NFe(\d{44})$/);
  return m ? m[1] : null;
}

/** Fallback da chave: elemento <chNFe> com exatamente 44 dígitos. */
function extraiChNFe(texto) {
  if (!texto) return null;
  const t = String(texto).trim();
  return /^\d{44}$/.test(t) ? t : null;
}

function parseComRegex(xmlText) {
  // Saneamento mínimo de estrutura: XML malformado típico (tag não fechada,
  // documento vazio, conteúdo que não é XML) é rejeitado aqui.
  if (typeof xmlText !== 'string' || xmlText.trim() === '') {
    throw erroParse('entrada vazia ou não é string.');
  }
  if (!/<\??[a-zA-Z]/.test(xmlText)) {
    throw erroParse('conteúdo não parece XML (sem nenhuma tag de abertura).');
  }

  // Tag de abertura de <infNFe> com seus atributos (onde mora o Id).
  const mAbertura = xmlText.match(/<(?:\w+:)?infNFe\b([^>]*)>/i);
  if (!mAbertura) {
    throw erroParse('elemento <infNFe> não encontrado — não é um XML de NF-e.');
  }
  const mId = mAbertura[1].match(/\bId\s*=\s*"([^"]*)"/i);
  let chave = extraiChaveDoId(mId && mId[1]);

  // Fallback: <chNFe> (ex.: nfeProc/protNFe/infProt/chNFe).
  if (!chave) {
    chave = extraiChNFe(tagTexto(xmlText, 'chNFe'));
  }

  const ide = bloco(xmlText, 'ide');
  const emit = bloco(xmlText, 'emit');
  const dest = bloco(xmlText, 'dest');
  const icmsTot = bloco(xmlText, 'ICMSTot');
  if (!ide) throw erroParse('bloco <ide> ausente ou malformado.');
  if (!emit) throw erroParse('bloco <emit> ausente ou malformado.');
  if (!icmsTot) throw erroParse('bloco <ICMSTot> ausente ou malformado.');

  return montaResultado({
    chave,
    numero: tagTexto(ide, 'nNF'),
    serie: tagTexto(ide, 'serie'),
    data_emissao: tagTexto(ide, 'dhEmi') || tagTexto(ide, 'dEmi'),
    emitente_cnpj: tagTexto(emit, 'CNPJ'),
    destinatario_cnpj: dest ? tagTexto(dest, 'CNPJ') : null,
    valor_bc_icms: tagTexto(icmsTot, 'vBC'),
    valor_icms: tagTexto(icmsTot, 'vICMS'),
    valor_total: tagTexto(icmsTot, 'vNF'),
  });
}

/* --------------------------------------------------------------------------
 * Montagem + validação do resultado
 * ------------------------------------------------------------------------ */

function montaResultado(campos) {
  if (!campos.chave) {
    throw erroParse(
      'chave de acesso não encontrada (infNFe/@Id="NFe"+44 dígitos ou <chNFe>).'
    );
  }
  return {
    chave: campos.chave,
    numero: campos.numero === null ? null : String(campos.numero),
    serie: campos.serie === null ? null : String(campos.serie),
    data_emissao: extraiData(campos.data_emissao),
    emitente_cnpj: campos.emitente_cnpj,
    destinatario_cnpj: campos.destinatario_cnpj,
    valor_bc_icms: toNum(campos.valor_bc_icms),
    valor_icms: toNum(campos.valor_icms),
    valor_total: toNum(campos.valor_total),
  };
}

/**
 * Faz o parse de um XML de NF-e (nfeProc ou NFe pura).
 * @param {string} xmlText
 * @returns {{chave:string, numero:string|null, serie:string|null,
 *   data_emissao:string|null, emitente_cnpj:string|null,
 *   destinatario_cnpj:string|null, valor_bc_icms:number|null,
 *   valor_icms:number|null, valor_total:number|null}}
 */
export function parseNFe(xmlText) {
  if (typeof DOMParser !== 'undefined') {
    return parseComDOM(xmlText);
  }
  return parseComRegex(xmlText);
}
