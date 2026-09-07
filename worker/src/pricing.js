// pricing.js — matemática de deságio justo e da transição LC 214/2025.
//
// Fórmulas exatas (contrato observado em produção):
//   g por rating: { A: 0.01, B: 0.05, C: 0.12 }
//   fair_value  = vn * (1 - g) / (1 + i)^T
//   desagio_justo = 1 - fair/vn            (arredondado em 4 casas)
//   pv240       = (vn/240) * (1 - (1+i)^-240) / i      (anuidade da transição)
//   perda       = 1 - pv240/vn             (arredondado em 4 casas)
// Valores monetários de saída são centavos inteiros (Math.round) — os arredondamentos
// de 4 casas usam o valor NÃO arredondado de fair/pv, para reproduzir o contrato.

export const GRADE_G = Object.freeze({ A: 0.01, B: 0.05, C: 0.12 });

export const PARCELAS_LC214 = 240;

export const DEFAULT_I = 0.015;
export const DEFAULT_T = 12;

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// amountCents: inteiro em centavos; grade: 'A' | 'B' | 'C'; i: taxa mensal; T: meses.
// Retorna exatamente o envelope do contrato (inputs + g + fair + deságio + transição).
export function computePricing(amountCents, grade, i, T) {
  const g = GRADE_G[grade];

  const fair = (amountCents * (1 - g)) / Math.pow(1 + i, T);
  const fairValueCents = Math.round(fair);
  const desagioJusto = round4(1 - fair / amountCents);

  // Com i = 0 a fórmula da anuidade degenera para vn (limite); tratado explicitamente.
  const pv240 =
    i === 0 ? amountCents : (amountCents / PARCELAS_LC214) * ((1 - Math.pow(1 + i, -PARCELAS_LC214)) / i);
  const valorPresenteCents = Math.round(pv240);
  const perda = round4(1 - pv240 / amountCents);

  return {
    inputs: { amount_cents: amountCents, grade, i, T },
    g,
    fair_value_cents: fairValueCents,
    desagio_justo: desagioJusto,
    transicao_lc214: {
      parcelas: PARCELAS_LC214,
      valor_presente_cents: valorPresenteCents,
      perda,
    },
  };
}
