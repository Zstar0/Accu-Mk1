/** Mode-aware vial numbering. Legacy families: the parent IS Vial 1, so a
 *  sub-sample with vial_sequence N is "Vial N+1". Container families
 *  (parent.container_mode — 2026-06-10-container-parent-design.md): the
 *  parent is a pure depository, S01 IS Vial 1, label = vial_sequence.
 *  EVERY surface that renders a vial number must go through these. */

export function vialPosition(vialSequence: number, containerMode: boolean): number {
  return containerMode ? vialSequence : vialSequence + 1
}

export function vialLabel(vialSequence: number, containerMode: boolean): string {
  return `Vial ${vialPosition(vialSequence, containerMode)}`
}

/** Family-size denominator for "Vial K of N" strings. */
export function vialTotal(subSampleCount: number, containerMode: boolean): number {
  return containerMode ? subSampleCount : subSampleCount + 1
}
