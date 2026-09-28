import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useEntitySearch } from '@/hooks/use-flags'
import { useCreateNode } from '@/services/boards'
import { useDirectoryUsers } from '@/services/groups'
import type { BoardDetail, NodeCreate } from '@/lib/api-boards'
import { FRAME_DEFAULT } from './board-mapping'
import { isSafeHttpUrl } from './open-external'

type Step = 'kind' | 'person' | 'link' | 'entity'
const ENTITY_KINDS: { type: string; label: string }[] = [
  { type: 'document', label: 'Document' },
  { type: 'sample', label: 'Sample' },
  { type: 'order', label: 'Order' },
  { type: 'worksheet', label: 'Worksheet' },
]

export function AddNodePalette({
  board,
  open,
  onOpenChange,
  dropAt,
  parentId,
}: {
  board: BoardDetail
  open: boolean
  onOpenChange: (o: boolean) => void
  dropAt: { x: number; y: number }
  parentId: number | null
}) {
  const create = useCreateNode(board.slug)
  const [step, setStep] = useState<Step>('kind')
  const [entityType, setEntityType] = useState<string>('document')
  const [q, setQ] = useState('')
  const [url, setUrl] = useState('')
  const directory = useDirectoryUsers()
  const hits = useEntitySearch(entityType, q)

  const submit = (data: NodeCreate) => {
    create.mutate(
      { ...data, x: dropAt.x, y: dropAt.y, parent_id: parentId },
      {
        onSuccess: () => {
          onOpenChange(false)
          setStep('kind')
          setQ('')
          setUrl('')
        },
      }
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        onOpenChange(o)
        if (!o) {
          setStep('kind')
          setQ('')
          setUrl('')
        }
      }}
    >
      <DialogContent className="p-0">
        <DialogTitle className="sr-only">Add to board</DialogTitle>
        <Command shouldFilter={step !== 'entity'}>
          {step === 'kind' && (
            <>
              <CommandInput placeholder="Add to the board..." />
              <CommandList>
                <CommandEmpty>Nothing matches.</CommandEmpty>
                <CommandGroup heading="Arrange">
                  <CommandItem
                    onSelect={() =>
                      submit({
                        kind: 'frame',
                        label: 'New frame',
                        w: FRAME_DEFAULT.width,
                        h: FRAME_DEFAULT.height,
                        data: { color: 'slate' },
                      })
                    }
                  >
                    Frame
                  </CommandItem>
                  <CommandItem
                    onSelect={() =>
                      submit({
                        kind: 'text',
                        label: 'Heading',
                        data: { size: 'md' },
                      })
                    }
                  >
                    Text
                  </CommandItem>
                  <CommandItem
                    onSelect={() =>
                      submit({
                        kind: 'note',
                        label: 'Note',
                        data: { markdown: '' },
                      })
                    }
                  >
                    Note
                  </CommandItem>
                  <CommandItem onSelect={() => setStep('link')}>
                    Link
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading="Live">
                  <CommandItem onSelect={() => setStep('person')}>
                    Person
                  </CommandItem>
                  {ENTITY_KINDS.map(k => (
                    <CommandItem
                      key={k.type}
                      onSelect={() => {
                        setEntityType(k.type)
                        setStep('entity')
                      }}
                    >
                      {k.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'person' && (
            <>
              <CommandInput placeholder="Who?" />
              <CommandList>
                <CommandEmpty>No one matches.</CommandEmpty>
                <CommandGroup heading="People">
                  {(directory.data ?? []).map(u => {
                    const name =
                      [u.first_name, u.last_name].filter(Boolean).join(' ') ||
                      u.email
                    return (
                      <CommandItem
                        key={u.id}
                        value={`${name} ${u.email}`}
                        onSelect={() =>
                          submit({
                            kind: 'person',
                            label: name,
                            data: { user_id: u.id },
                          })
                        }
                      >
                        {name}{' '}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {u.email}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'entity' && (
            <>
              <CommandInput
                placeholder={`Search ${entityType}...`}
                value={q}
                onValueChange={setQ}
              />
              <CommandList>
                <CommandEmpty>
                  {q.length < 2
                    ? 'Type at least two characters.'
                    : 'No matches.'}
                </CommandEmpty>
                <CommandGroup heading={entityType}>
                  {(hits.data ?? []).map(hit => (
                    <CommandItem
                      key={hit.entity_id}
                      value={hit.label}
                      onSelect={() =>
                        submit({
                          kind: 'entity',
                          label: '',
                          entity_type: entityType,
                          entity_id: hit.entity_id,
                          data: {},
                        })
                      }
                    >
                      {hit.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </>
          )}
          {step === 'link' && (
            <form
              className="flex gap-2 p-3"
              onSubmit={e => {
                e.preventDefault()
                if (isSafeHttpUrl(url))
                  submit({
                    kind: 'link',
                    label: new URL(url).host,
                    data: { url: url.trim() },
                  })
              }}
            >
              <input
                className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
                placeholder="https://..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                aria-label="Link URL"
              />
              <button
                type="submit"
                className="h-8 rounded-md border px-3 text-xs"
                disabled={!isSafeHttpUrl(url)}
              >
                Add link
              </button>
            </form>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
