/**
 * Pure scoping-transition helpers for the type-bucket board (slice 7).
 *
 * A flag type's `entity_types` is its scope: empty = global ("All items"),
 * otherwise the code-entity + item-kind slugs it may be raised on. The board
 * renders one bucket per slug (plus an "All items" bucket for globals) and
 * mutates scope by dragging/removing chips. All the set logic lives here so the
 * DnD wiring stays dumb and the semantics are unit-tested; a type may sit in
 * MULTIPLE buckets (its scope carries multiple slugs).
 */

/** Add a bucket slug to a type's scope (idempotent, order-preserving). A
 *  previously-global type ([]) becomes restricted to just this slug. */
export function addTypeScope(entityTypes: string[], slug: string): string[] {
  return entityTypes.includes(slug) ? entityTypes : [...entityTypes, slug]
}

/** Remove a bucket slug from a type's scope. Dropping the last slug makes the
 *  type global again ([] = All items). */
export function removeTypeScope(entityTypes: string[], slug: string): string[] {
  return entityTypes.filter(s => s !== slug)
}

/** Clear a type's scope → global (available in every bucket). */
export function clearTypeScope(): string[] {
  return []
}

/** A global type (empty scope) lives in the "All items" bucket only. */
export function isGlobalScope(entityTypes: string[]): boolean {
  return entityTypes.length === 0
}

/** Whether a type belongs in a specific bucket (its scope names that slug). */
export function isInBucket(entityTypes: string[], slug: string): boolean {
  return entityTypes.includes(slug)
}
