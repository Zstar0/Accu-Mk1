import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import {
  SampleFormIcon,
  SampleFormIconById,
} from '@/components/common/SampleFormIcon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AnalysisProfile, AnalysisServiceRecord } from '@/lib/api'
import {
  createProfileCoaVariant,
  patchProfileCoaVariant,
  type ProfileCoaVariant,
} from '@/lib/api-profile-coa-variants'
import {
  profileCoaVariantKeys,
  useProfileCoaVariants,
} from '@/services/profile-coa-variants'
import { useSampleForms } from '@/services/sample-forms'
import { useUIStore } from '@/store/ui-store'
import { CoaVariantEditor } from './CoaVariantEditor'
import {
  UNSAVED_VERSION_PROMPT,
  draftErrors,
  draftFromVariant,
  draftToWire,
  isDraftDirty,
  newDraft,
  summaryLine,
  type VariantDraft,
} from './coa-variant-logic'

export interface ProfileCoaVariantsSectionProps {
  profile: AnalysisProfile
  savedMemberIds: number[]
  membersLoading: boolean
  services: Pick<AnalysisServiceRecord, 'id' | 'title'>[]
  onDirtyChange: (dirty: boolean) => void
}

interface VersionCard {
  key: string
  /** null = a new form, not written until Save */
  saved: ProfileCoaVariant | null
  draft: VariantDraft
}

/** The summary is built from the wire form, where a blank Custom and Leave off
 *  look the same, so a blank Custom must not reach it. */
function cardSummary(draft: VariantDraft): string {
  return Object.keys(draftErrors(draft)).length > 0
    ? 'A Custom field is still blank'
    : summaryLine(draftToWire(draft))
}

export function ProfileCoaVariantsSection({
  profile,
  savedMemberIds,
  membersLoading,
  services,
  onDirtyChange,
}: ProfileCoaVariantsSectionProps) {
  const queryClient = useQueryClient()
  const variants = useProfileCoaVariants(profile.id)
  const forms = useSampleForms()
  const navigateToAnalysisService = useUIStore(s => s.navigateToAnalysisService)

  const [drafts, setDrafts] = useState<Record<string, VariantDraft>>({})
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const cards: VersionCard[] = [
    ...(variants.data ?? []).map(saved => {
      const key = `v${saved.id}`
      return { key, saved, draft: drafts[key] ?? draftFromVariant(saved) }
    }),
    // A new form, or a version stopped elsewhere: its draft stays until Cancel.
    ...Object.entries(drafts)
      .filter(
        ([, draft]) => !variants.data?.some(v => v.id === draft.variantId)
      )
      .map(([key, draft]) => ({ key, saved: null, draft })),
  ]

  const anyDirty = cards.some(c => isDraftDirty(c.draft, c.saved))
  useEffect(() => {
    onDirtyChange(anyDirty)
  }, [anyDirty, onDirtyChange])

  // Empty until both lists are in: before that it could offer a form that
  // already has a version, and Save would get a 409.
  const takenFormIds = new Set(cards.map(c => c.draft.formId))
  const pickable = variants.data
    ? (forms.data ?? []).filter(f => f.active && !takenFormIds.has(f.id))
    : []

  const dropDraft = (key: string) =>
    setDrafts(({ [key]: _dropped, ...rest }) => rest)

  const pickForm = (value: string) => {
    const form = pickable.find(f => String(f.id) === value)
    if (!form) return
    const key = `new-${form.id}`
    setDrafts(d => ({ ...d, [key]: newDraft(form.id, form.name) }))
    setOpenKey(key)
    setPickerOpen(false)
  }

  /** A failure keeps the card, the draft and its Unsaved tag. */
  const write = async (
    key: string,
    call: () => Promise<unknown>,
    doneMessage: string
  ) => {
    setSaving(true)
    try {
      await call()
      toast.success(doneMessage)
      // Refetch before dropping the draft, so the card never flashes the old row.
      await queryClient.invalidateQueries({
        queryKey: profileCoaVariantKeys.forProfile(profile.id),
      })
      dropDraft(key)
      // Another card may have been opened while this one was saving.
      setOpenKey(open => (open === key ? null : open))
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the COA text'
      )
      // After a 409 the list is what changed, so show what is there now.
      await queryClient.invalidateQueries({
        queryKey: profileCoaVariantKeys.forProfile(profile.id),
      })
    } finally {
      setSaving(false)
    }
  }

  const save = ({ key, draft }: VersionCard) => {
    const wire = draftToWire(draft)
    const { variantId } = draft
    void write(
      key,
      () =>
        variantId === null
          ? createProfileCoaVariant(profile.id, {
              sample_form_id: draft.formId,
              ...wire,
            })
          : patchProfileCoaVariant(variantId, wire),
      `${draft.formName} text saved`
    )
  }

  const stop = ({ key, draft }: VersionCard, variantId: number) => {
    const { formName } = draft
    const question = `Stop using the ${formName} version? ${formName} COAs go back to the Default text. Published COAs stay as they are until they are regenerated.`
    if (!window.confirm(question)) return
    void write(
      key,
      () => patchProfileCoaVariant(variantId, { active: false }),
      `${formName} COAs now print the Default text`
    )
  }

  const addRule = (serviceId: number) => {
    if (anyDirty && !window.confirm(UNSAVED_VERSION_PROMPT)) return
    navigateToAnalysisService(serviceId)
  }

  return (
    <div className="border-t pt-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">COA text by sample form</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pickable.length === 0}
          onClick={() => setPickerOpen(open => !open)}
        >
          <Plus className="mr-1 h-3 w-3" />
          Add form
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Every sample prints the Default text above. A form listed here prints
        its own version instead, field by field.
      </p>

      {pickerOpen && pickable.length > 0 && (
        <Select value="" onValueChange={pickForm}>
          <SelectTrigger aria-label="Form" className="h-8 w-56 text-sm">
            <SelectValue placeholder="Select form…" />
          </SelectTrigger>
          <SelectContent>
            {pickable.map(f => (
              <SelectItem key={f.id} value={String(f.id)}>
                <SampleFormIcon icon={f.icon} />
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {variants.isLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {(variants.isError || forms.isError) && (
        <p className="text-sm text-destructive">
          Could not load the versions and sample forms for this profile.
        </p>
      )}

      {cards.map(card => {
        const { key, saved, draft } = card
        const open = key === openKey
        const dirty = isDraftDirty(draft, saved)
        return (
          <div
            key={key}
            data-testid={`coa-variant-card-${draft.formId}`}
            className="space-y-3 rounded-md border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <SampleFormIconById id={draft.formId} />
              <span className="text-sm font-medium">{draft.formName}</span>
              {dirty && <Badge variant="secondary">Unsaved</Badge>}
              <span className="ml-auto text-xs text-muted-foreground">
                {cardSummary(draft)}
              </span>
              {!open && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDrafts(d => ({ ...d, [key]: draft }))
                    setOpenKey(key)
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
            {open && (
              // Text typed during a save is never sent and goes when the draft
              // does, so the whole editor locks until the write and refetch end.
              <fieldset disabled={saving} className="contents">
                <CoaVariantEditor
                  draft={draft}
                  onChange={next => setDrafts(d => ({ ...d, [key]: next }))}
                  defaults={profile}
                  savedMemberIds={savedMemberIds}
                  membersLoading={membersLoading}
                  services={services}
                  dirty={dirty}
                  saving={saving}
                  onSave={() => save(card)}
                  onCancel={() => {
                    dropDraft(key)
                    setOpenKey(null)
                  }}
                  onStop={saved ? () => stop(card, saved.id) : undefined}
                  onAddRule={addRule}
                />
              </fieldset>
            )}
          </div>
        )
      })}
    </div>
  )
}
