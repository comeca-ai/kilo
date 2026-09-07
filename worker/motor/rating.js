/**
 * rating.js — ratingV1: grade heurística do dossiê.
 *
 * ⚠️ DISCLAIMER — HEURÍSTICO v1:
 * Este rating é uma heurística de triagem (v1), NÃO é parecer fiscal,
 * contábil ou jurídico. Ele resume (a) completude documental e (b) achados
 * dos checks determinísticos em uma grade A/B/C. Limites e pesos são
 * arbitrários e versionados junto ao ruleset; qualquer mudança exige nova
 * versão do motor e recálculo dos dossiês afetados. Não use como única
 * base de decisão de crédito tributário.
 *
 * Regra v1:
 *   1) Nota base pela completude (0..1):
 *        completude = 1.0  → A
 *        completude ≥ 0.75 → B
 *        senão             → C
 *   2) Rebaixa 1 faixa se houver ≥ 1 finding "critica" FISCAL — ou seja,
 *      EXCLUINDO o check DOC-COMPLETE. Refinamento deliberado da fórmula
 *      literal: documento faltante já reduz a completude (passo 1), logo
 *      penalizá-lo de novo como critica seria dupla punição pelo mesmo
 *      fato. Sem este refinamento, qualquer dossiê com documento faltante
 *      cairia 2 faixas e o caso "3/4 docs coerente → B" seria impossível.
 *   3) Rebaixa MAIS 1 faixa se houver ≥ 3 findings no total (qualquer
 *      severidade, incluindo DOC-COMPLETE). Piso: C.
 *
 * g = fração heurística associada à grade (parâmetro de precificação/triagem):
 *   A → 0.01, B → 0.05, C → 0.12
 */

const GRADES = ['A', 'B', 'C'];

const G_POR_GRADE = Object.freeze({ A: 0.01, B: 0.05, C: 0.12 });

function basePorCompletude(completude) {
  if (completude >= 1.0) return 'A';
  if (completude >= 0.75) return 'B';
  return 'C';
}

function rebaixa(grade, faixas) {
  const i = GRADES.indexOf(grade);
  const j = Math.min(i + faixas, GRADES.length - 1); // piso: C
  return GRADES[j];
}

/**
 * Calcula o rating v1.
 * @param {{completude:number, findings:Array}} entrada
 * @returns {{grade:'A'|'B'|'C', g:number, detalhe:object}}
 */
export function ratingV1({ completude, findings }) {
  if (
    typeof completude !== 'number' ||
    !Number.isFinite(completude) ||
    completude < 0 ||
    completude > 1
  ) {
    throw new Error(
      `ratingV1: completude deve ser número em [0,1], recebeu ${completude}.`
    );
  }
  const lista = findings || [];
  const qtdFindings = lista.length;
  // Criticas "fiscais": exclui DOC-COMPLETE (ver docstring — anti dupla
  // penalização com a completude).
  const qtdCriticas = lista.filter(
    (f) => f.severity === 'critica' && f.check !== 'DOC-COMPLETE'
  ).length;

  const base = basePorCompletude(completude);
  let grade = base;
  let rebaixamentos = 0;

  if (qtdCriticas >= 1) {
    grade = rebaixa(grade, 1);
    rebaixamentos += 1;
  }
  if (qtdFindings >= 3) {
    grade = rebaixa(grade, 1);
    rebaixamentos += 1;
  }

  return {
    grade,
    g: G_POR_GRADE[grade],
    detalhe: {
      heuristico: 'rating_v1',
      disclaimer:
        'Heurística de triagem v1 — não é parecer fiscal, contábil ou jurídico.',
      completude,
      base,
      rebaixamentos,
      qtd_findings: qtdFindings,
      qtd_criticas_fiscais: qtdCriticas,
      regra:
        'base por completude (1.0→A, ≥0.75→B, senão C); −1 faixa se ≥1 critica fiscal (exclui DOC-COMPLETE, já precificado na completude); −1 faixa se ≥3 findings; piso C',
    },
  };
}
