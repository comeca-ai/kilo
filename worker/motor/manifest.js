/**
 * manifest.js — manifesto de entrada e hash de saída.
 *
 * O manifesto amarra cada documento do intake ao seu SHA-256 (calculado
 * sobre os bytes ORIGINAIS no upload) e o manifest_hash é o SHA-256 do
 * JSON canônico da lista. Juntos, manifest_hash + ruleset_version +
 * output_hash formam o contrato de reprodutibilidade do dossiê.
 *
 * Determinismo: os arquivos são ordenados por (kind, name) antes do hash,
 * então a ORDEM DE ENVIO dos documentos não altera o manifest_hash.
 */

import { canonicalStringify, sha256Hex } from './canonical.js';

/**
 * Monta o manifesto dos documentos de entrada.
 * @param {Array<{kind:string, name:string, bytes:number, sha256:string}>} docs
 * @returns {Promise<{files:Array<{kind:string, name:string, sha256:string, bytes:number}>, manifest_hash:string}>}
 */
export async function buildManifest(docs) {
  const files = (docs || [])
    .map((d) => ({
      kind: d.kind,
      name: d.name,
      bytes: d.bytes,
      sha256: d.sha256,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0;
    });

  const manifest_hash = await sha256Hex(canonicalStringify({ files }));
  return { files, manifest_hash };
}

/**
 * Hash de saída: SHA-256 do dossiê canônico. Dois dossiês com o mesmo
 * output_hash são byte-a-byte equivalentes na serialização canônica.
 * @param {object} dossier
 * @returns {Promise<string>}
 */
export async function buildOutputHash(dossier) {
  return sha256Hex(canonicalStringify(dossier));
}
