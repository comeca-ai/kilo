// ruleset.js — ruleset fiscal servido por GET /api/ruleset e embutido no passaporte.
//
// O objeto RULESET é congelado: o ruleset_hash é SHA-256 do JSON canônico dele, então
// qualquer alteração acidental mudaria o hash e quebraria verificações externas.
// O hash é computado uma única vez no carregamento do isolate (top-level await é
// suportado em Workers com formato ESM).

import { sha256HexCanonical } from './canonical.js';

export const RULESET_VERSION = 'BR-SP-CAT42@v2026.09';

export const RULESET = Object.freeze({
  rule_id: 'BR-SP-CAT42',
  version: 'v2026.09',
  jurisdiction: 'BR-SP',
  credit_kind: 'ICMS_ACCUMULATED',
  required_docs: ['efd_icms_ipi', 'nfe_xml', 'apuracao', 'livro_registro'],
  checks: [
    { id: 'DOC-COMPLETE', desc: 'Todos os documentos exigidos pela rota estão presentes' },
    { id: 'PERIODO-COERENTE', desc: 'Competência do EFD bate com o período de referência' },
    { id: 'VALOR-POSITIVO', desc: 'Valor do crédito é positivo e informado em centavos' },
    { id: 'IE-PRESENTE', desc: 'Inscrição estadual do estabelecimento informada' },
  ],
});

// "sha256:<hex64>" — hoje: sha256:49878474f494a1545a3c3e94a04f4b031e9057d25c5e734fd9fe294e98f383d7
export const RULESET_HASH = 'sha256:' + (await sha256HexCanonical(RULESET));
