/**
 * @module Supervision/compressSupervision
 * @description
 * Compress supervision - Docs/02 3-5.
 * Monitor context compression, ensure critical info not lost.
 */

import type { Result } from '../../Infra/types.js';
import { ok } from '../../Infra/types.js';

export interface CompressSupervisionResult {
  interventionNeeded: boolean;
  compressionRatio: number;
  criticalEntriesLost: boolean;
  recommendation?: string;
}

export function runCompressSupervision(
  tokensBefore: number,
  tokensAfter: number,
  droppedEntryTypes: string[],
): Result<CompressSupervisionResult> {
  const compressionRatio = tokensBefore > 0 ? tokensAfter / tokensBefore : 1;
  const criticalTypes = ['SYSTEM_PROMPT', 'ROLE_DEFINITION', 'IMMUTABLE_CONSTRAINT'];
  const criticalEntriesLost = droppedEntryTypes.some(t => criticalTypes.includes(t));

  const interventionNeeded = criticalEntriesLost || compressionRatio < 0.5;

  return ok({
    interventionNeeded,
    compressionRatio,
    criticalEntriesLost,
    recommendation: interventionNeeded
      ? 'Low compression ratio or critical entries lost'
      : undefined,
  });
}
