# Variance Testing — How Should We Certify It?
### Lab decision brief · 2026-06-14

## What we're asking
We offer **variance testing**: a customer sends us **multiple vials from the same lot**, and we
test each vial for **Identity, Purity, and Quantity**. We need the lab's guidance on **how multiple
vials should roll up onto a single Certificate of Analysis (COA)** — and we're proposing that the
per-vial detail live on a **separate Variance Report**.

This is a *uniformity / multi-unit* situation (distinct units from one lot), not repeat
measurements of a single homogeneous sample. The closest formal reference is **USP <905>
Uniformity of Dosage Units** (acceptance considers both the mean **and** individual unit
deviations). We are not GMP-pharma; our **ISO/IEC 17025** scope and the lab's SOPs govern what
actually applies — that's your call.

## The structure we're leaning toward
- **COA** → one **reportable result and one conformance verdict per test** (the lot's certified result).
- **Variance Report** → every vial's individual Identity / Purity / Quantity result, each vial's
  pass/fail, and the aggregate.

We need you to confirm that split and set the rules below.

---

## Worked example — real sample P-0149 (BPC-157, purity spec ≥ 98.0%)

| Vial | Identity | Purity | Quantity |
|------|----------|--------|----------|
| 1    | BPC-157 ✓ (confirmed) | 99.99% | 13 mg/mL |
| 2    | BPC-157 ✓ (confirmed) | 97.25% | 15 mg/mL |
| 3    | **not confirmed** ✗   | 96.24% | 16 mg/mL |

This one sample lands on **opposite COA verdicts** depending on the rules you choose below — which
is exactly why we need them pinned down.

---

## Decisions we need from the lab

**1. Purity / Quantity — how to aggregate and decide pass/fail on the COA**
- **(A) Mean only:** report the mean, verdict on the mean. → mean of the identity-confirmed vials
  (99.99, 97.25) = **98.62% → CONFORMS**.
- **(B) Mean + individual check (USP <905> style):** report the mean, but the lot **fails/flags** if
  **any** individual vial is out of spec. → Vial 2 = 97.25% < 98% → **lot does not conform**.
- _Which model? (This is the central decision.)_  ▢ A   ▢ B   ▢ Other: ______________

**2. Identity — it can't be averaged**
A vial that isn't the declared peptide (Vial 3) is a genuine finding (mislabeled / contaminated /
non-uniform unit).
- Report identity as **"N of M vials confirmed"** (here: 2 of 3)?  ▢ Yes  ▢ No
- Does **one** identity miss make the lot **NOT CONFORM** on identity, or is it reported with a note?
  ▢ Lot fails identity   ▢ Report + note   ▢ Other: ______________
- Should an identity-failed vial be **excluded** from the Purity/Quantity mean (its values aren't
  meaningful for the declared peptide)?  ▢ Exclude   ▢ Include

**3. What the COA displays**
- ▢ Single aggregate value only  ▢ Aggregate **+ spread** (e.g. "98.6%, n = 3" or mean ± range)

**4. Quantity (informational — no spec today)**
- Report as:  ▢ Mean   ▢ Range   ▢ Mean ± range   ▢ Other: ______________

---

## Our suggested default (please confirm or override)
Grounded in the uniformity rationale — a non-uniform lot should be visible on the certificate:
- **COA:** one verdict per test.
  - **Purity/Quantity:** report the **mean**, but **fail/flag the lot if any identity-confirmed vial
    is out of spec** (Decision 1 = B). Conservative and defensible for multi-unit lots.
  - **Identity:** report **"N of M confirmed"**; **any** non-match → lot **does not conform** on
    identity. **Exclude** identity-failed vials from the Purity/Quantity mean.
  - Show **mean + n** on the certificate; full detail on the Variance Report.
- **Variance Report:** every vial, every result, individual pass/fail, plus the aggregate.

Under this default, **P-0149 → DOES NOT CONFORM** (Vial 2 purity below spec + Vial 3 identity miss),
which we believe correctly reflects a non-uniform lot.

---

## Sign-off
Decision 1: ________  Decision 2: ________  Decision 3: ________  Decision 4: ________

Approved by: ____________________   Date: __________   Notes: ______________________________
