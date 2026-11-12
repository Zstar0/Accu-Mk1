/** Help wording for the Variance surfaces (the overlay and the parent page's
 *  Variance row). All of it lives here so the team can edit it in one place.
 *  Plain words, short sentences. Each entry: a title and a few short lines. */
export interface VarianceHelpEntry {
  title: string
  lines: string[]
}

export const VARIANCE_HELP = {
  overview: {
    title: 'What Variance is',
    lines: [
      'Extra vials of the same lot, run for the same test, to show how much results differ from vial to vial.',
      'Each test bought with Variance has one core run and one or more replicate runs.',
    ],
  },
  status: {
    title: 'Where the set stands',
    lines: [
      'Results in: every counted run has a result.',
      'Signed off: every included replicate is signed off. The lock also needs the results of a core vial in the set promoted.',
      'Locked: which vials count is frozen.',
    ],
  },
  lock_banner: {
    title: 'Locked',
    lines: [
      'Which vials count cannot be changed until the set is unlocked.',
      'Anyone can unlock the set for now. Every lock and unlock is logged.',
    ],
  },
  test_card: {
    title: 'One test, every run',
    lines: [
      'The core run first, then each replicate run in vial order.',
      'Each value is shown as the sample page shows it, with its unit.',
    ],
  },
  core: {
    title: 'Core run',
    lines: [
      "The result of record. It goes to the sample's own analysis row, the row you verify and the one the certificate prints (for endotoxin, Rapid PCR, USP 71 and heavy metals, as the first run).",
      'For endotoxin, Rapid PCR, USP 71 and heavy metals the core run always counts. It cannot be excluded here.',
      "For HPLC every vial, the core included, can be left out of the numbers. That does not change the sample's reported value.",
    ],
  },
  replicate: {
    title: 'Replicate run',
    lines: [
      'Entered and signed off on its own vial with "Verify (Variance)".',
      'For endotoxin, Rapid PCR, USP 71 and heavy metals it is never promoted. The certificate prints it as its own row, labelled with its vial (a test that pools vials for one run, such as heavy metals, says digest).',
    ],
  },
  include: {
    title: 'Included or excluded',
    lines: [
      'An excluded replicate is left out of the numbers here and off the certificate. An excluded HPLC core vial is left out of the numbers. A reason is recorded with each.',
      'For endotoxin, Rapid PCR, USP 71 and heavy metals, the lock needs exactly as many included replicates as runs bought: no fewer and no extra.',
    ],
  },
  other_vials: {
    title: 'Other vials',
    lines: [
      'These vials are not part of any test card above, for example a test bought without Variance.',
      'One that is included still counts toward the 2-vial minimum for locking.',
    ],
  },
  signoff: {
    title: 'Signed off',
    lines: [
      'Every current result on that vial is signed off: verified with "Verify (Variance)", or promoted to the sample (core run).',
    ],
  },
  footer_addon: {
    title: 'Within spec',
    lines: [
      'How many counted runs meet the spec, judged by the same rule as the sample page.',
      'Each value is listed on its own. No mean is shown or printed for this test.',
    ],
  },
  footer_hplc: {
    title: 'HPLC numbers',
    lines: [
      'Mean, SD and CV across the vials in the set.',
      'Identity shows how many vials conform.',
    ],
  },
  reported_value: {
    title: 'Reported value (HPLC only)',
    lines: [
      "Which vial's value, or the mean, becomes the sample's reported result.",
      'Available once the set is locked.',
    ],
  },
  lock_button: {
    title: 'Lock',
    lines: [
      'Freezes which vials count.',
      'It needs at least 2 vials in the set, the results of every vial in the set signed off for the tests bought with Variance (a core vial in the set needs its results promoted), and a vial with results for every run bought.',
      'For endotoxin, Rapid PCR, USP 71 and heavy metals it also needs exactly as many included replicates as runs bought: no fewer and no extra.',
      'After locking, which vials count cannot be changed until the set is unlocked.',
    ],
  },
  greyed_out: {
    title: 'Why this is greyed out',
    lines: ['The set is locked. Unlock the set to change this.'],
  },
  parent_row: {
    title: 'Variance',
    lines: [
      'The replicate runs of this test, one pill per vial.',
      "Click a pill to open that vial. The core run is on the sample's own row or rows in this section.",
    ],
  },
} satisfies Record<string, VarianceHelpEntry>

export type VarianceHelpId = keyof typeof VARIANCE_HELP
