/**
 * engine.js — orquestrador do motor de regras (FUNÇÃO PURA).
 *
 *   executar({ documents, ruleset, params }) → { dossier }
 *
 *   dossier = {
 *     ruleset: { rule_id, version },
 *     input_hash,        // sha256(canônico({files, ruleset, params}))
 *     completude,        // fração dos required_docs presentes (0..1)
 *     findings,          // achados determinísticos (ordenados)
 *     rating,            // ratingV1 (heurístico — ver disclaimer em rating.js)
 *     parsed_resumo,     // { qtd_nfe, qtd_c100, periodo_efd, skipped, errors }
 *     output_hash,       // sha256 do dossiê canônico SEM este campo
 *   }
 *
 * Determinismo garantido:
 *   - nada de Date.now()/Math.random()/relógio — datas entram em params;
 *   - manifesto ordenado por (kind, name, sha256);
 *   - findings ordenados por (check, evidence canônica);
 *   - parsed_resumo.skipped/errors ordenados por nome do arquivo.
 *
 * Documentos com kind "nfe_xml" devem trazer `text` (XML) para parse;
 * kind "efd_icms_ipi" deve trazer `text` (SPED). Demais kinds só contam
 * para a completude. Documento sem `text` tem o parse PULADO com nota em
 * parsed_resumo.skipped — o motor NUNCA inventa dados.
 */

import { canonicalStringify, sha256Hex } from './canonical.js';
import { parseNFe } from './nfe.js';
import { parseEFD } from './efd.js';
import { executarChecks } from './checks.js';
import { ratingV1 } from './rating.js';
import { buildManifest, buildOutputHash } from './manifest.js';

/** Kinds cujo conteúdo textual é parseado pelo motor. */
const KINDS_PARSEAVEIS = Object.freeze({
  nfe_xml: 'nfe',
  efd_icms_ipi: 'efd',
});

/**
 * Executa o motor sobre um conjunto de documentos.
 * @param {{documents:Array, ruleset:object, params:object}} entrada
 * @returns {Promise<{dossier:object}>}
 */
export async function executar({ documents, ruleset, params }) {
  if (!Array.isArray(documents)) {
    throw new Error('engine.executar: "documents" deve ser um array.');
  }
  if (!ruleset || !ruleset.rule_id || !ruleset.version) {
    throw new Error('engine.executar: ruleset inválido (precisa de rule_id e version).');
  }
  const paramsSeguro = params || {};

  // 1) Manifesto de entrada (ordenação determinística por kind/name/sha256).
  const manifesto = await buildManifest(documents);

  // 2) Parse dos documentos parseáveis. Ordem determinística: percorremos
  //    o manifesto (já ordenado), não a ordem de envio.
  const nfes = [];
  let efd = null;
  const skipped = [];
  const errors = [];

  for (const file of manifesto.files) {
    const papel = KINDS_PARSEAVEIS[file.kind];
    if (!papel) continue; // kind não parseável: só entra na completude

    const doc = documents.find(
      (d) => d.kind === file.kind && d.name === file.name && d.sha256 === file.sha256
    );
    if (!doc || typeof doc.text !== 'string') {
      skipped.push({
        name: file.name,
        kind: file.kind,
        motivo: 'sem text disponível — parse pulado (dados não inventados)',
      });
      continue;
    }
    try {
      if (papel === 'nfe') {
        nfes.push(parseNFe(doc.text));
      } else if (papel === 'efd') {
        if (efd !== null) {
          // Mais de uma EFD no dossiê: ambíguo, não escolhemos arbitrariamente.
          skipped.push({
            name: file.name,
            kind: file.kind,
            motivo: 'segunda EFD ignorada — o motor consolida apenas 1 EFD por execução',
          });
          continue;
        }
        efd = parseEFD(doc.text);
      }
    } catch (err) {
      errors.push({
        name: file.name,
        kind: file.kind,
        code: err.code || 'PARSE_ERROR',
        message: String(err.message || err),
      });
    }
  }

  skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  errors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // NF-e ordenadas por chave para que qualquer consumidor veja ordem estável.
  nfes.sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));

  const parsed = { nfes, efd, skipped, errors };

  // 3) Completude: fração dos required_docs presentes.
  const exigidos = ruleset.required_docs || [];
  const presentes = new Set(documents.map((d) => d.kind));
  const qtdPresentes = exigidos.filter((k) => presentes.has(k)).length;
  const completude =
    exigidos.length === 0 ? 1 : qtdPresentes / exigidos.length;

  // 4) Checks determinísticos.
  const findings = executarChecks({
    docs: documents,
    parsed,
    params: paramsSeguro,
    ruleset,
  });

  // 5) Rating heurístico v1 (ver disclaimer em rating.js).
  const rating = ratingV1({ completude, findings });

  // 6) Resumo do parse (sem inventar dados: só contagens e período real).
  const parsed_resumo = {
    qtd_nfe: nfes.length,
    qtd_c100: efd ? efd.totais.qtd_c100 : 0,
    periodo_efd: efd ? efd.periodo : null,
    skipped,
    errors,
  };

  // 7) input_hash: amarra documentos (hashes) + ruleset + params.
  const input_hash = await sha256Hex(
    canonicalStringify({
      files: manifesto.files,
      ruleset: {
        rule_id: ruleset.rule_id,
        version: ruleset.version,
        ruleset_hash: ruleset.ruleset_hash || null,
      },
      params: paramsSeguro,
    })
  );

  const dossierSemHash = {
    ruleset: { rule_id: ruleset.rule_id, version: ruleset.version },
    input_hash,
    completude,
    findings,
    rating,
    parsed_resumo,
  };

  // 8) output_hash: sha256 do dossiê canônico SEM o próprio output_hash.
  const output_hash = await buildOutputHash(dossierSemHash);

  return { dossier: { ...dossierSemHash, output_hash } };
}
