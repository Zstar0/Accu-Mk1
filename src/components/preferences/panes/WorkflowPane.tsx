import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Info, Loader2, Plus } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { SettingsSection } from '../shared/SettingsComponents'
import { useAuthStore } from '@/store/auth-store'
import {
  createWorkflowState,
  createWorkflowTransition,
  deleteWorkflowState,
  deleteWorkflowTransition,
  getWorkflowGraph,
  updateWorkflowState,
  updateWorkflowTransition,
  type WorkflowScope,
  type WorkflowState,
  type WorkflowStateUpdate,
  type WorkflowTransition,
  type WorkflowTransitionUpdate,
} from '@/lib/workflow-api'
import {
  CreateStateDialog,
  CreateTransitionDialog,
  StateDetailSheet,
  TransitionDetailSheet,
} from './workflow/WorkflowDrawers'

/**
 * Workflow settings pane (Task 9). Form-driven CRUD over the workflow
 * catalog — states + transitions per scope (sample | analysis). This is the
 * a11y/test fallback list view; Task 10 adds a React Flow canvas ABOVE this
 * list, it doesn't replace it.
 *
 * Catalog rows are documentation only while SENAITE remains system of
 * record (phase-out slice 3) — nothing here reads or writes live workflow
 * behavior, hence the persistent banner.
 */
export function WorkflowPane() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore(state => state.user?.role === 'admin')
  const queryClient = useQueryClient()

  const [scope, setScope] = useState<WorkflowScope>('sample')
  const [createStateOpen, setCreateStateOpen] = useState(false)
  const [createTransitionOpen, setCreateTransitionOpen] = useState(false)
  const [selectedStateId, setSelectedStateId] = useState<number | null>(null)
  const [selectedTransitionId, setSelectedTransitionId] = useState<
    number | null
  >(null)

  const graphQuery = useQuery({
    queryKey: ['workflow-graph', scope],
    queryFn: () => getWorkflowGraph(scope),
  })

  const invalidateGraph = () =>
    queryClient.invalidateQueries({ queryKey: ['workflow-graph', scope] })

  const onMutationError = (fallback: string) => (err: unknown) =>
    toast.error(err instanceof Error ? err.message : fallback)

  const createState = useMutation({
    mutationFn: createWorkflowState,
    onSuccess: () => {
      invalidateGraph()
      setCreateStateOpen(false)
    },
    onError: onMutationError('Failed to create state'),
  })
  const updateState = useMutation({
    mutationFn: ({ id, body }: { id: number; body: WorkflowStateUpdate }) =>
      updateWorkflowState(id, body),
    onSuccess: () => invalidateGraph(),
    onError: onMutationError('Failed to update state'),
  })
  const deleteState = useMutation({
    mutationFn: deleteWorkflowState,
    onSuccess: () => {
      invalidateGraph()
      setSelectedStateId(null)
    },
    onError: onMutationError('Failed to delete state'),
  })

  const createTransition = useMutation({
    mutationFn: createWorkflowTransition,
    onSuccess: () => {
      invalidateGraph()
      setCreateTransitionOpen(false)
    },
    onError: onMutationError('Failed to create transition'),
  })
  const updateTransition = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number
      body: WorkflowTransitionUpdate
    }) => updateWorkflowTransition(id, body),
    onSuccess: () => invalidateGraph(),
    onError: onMutationError('Failed to update transition'),
  })
  const deleteTransition = useMutation({
    mutationFn: deleteWorkflowTransition,
    onSuccess: () => {
      invalidateGraph()
      setSelectedTransitionId(null)
    },
    onError: onMutationError('Failed to delete transition'),
  })

  const states = graphQuery.data?.states ?? []
  const transitions = graphQuery.data?.transitions ?? []
  const stateLabelById = (id: number) =>
    states.find(s => s.id === id)?.label ?? `#${id}`

  const selectedState = states.find(s => s.id === selectedStateId) ?? null
  const selectedTransition =
    transitions.find(tr => tr.id === selectedTransitionId) ?? null

  return (
    <div className="space-y-6">
      <Alert>
        <Info />
        <AlertDescription>{t('preferences.workflow.banner')}</AlertDescription>
      </Alert>

      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          {t('preferences.workflow.readOnly')}
        </p>
      )}

      <Tabs value={scope} onValueChange={v => setScope(v as WorkflowScope)}>
        <TabsList>
          <TabsTrigger value="sample">
            {t('preferences.workflow.tabSample')}
          </TabsTrigger>
          <TabsTrigger value="analysis">
            {t('preferences.workflow.tabAnalysis')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value={scope} className="space-y-8 pt-4">
          {graphQuery.isLoading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {graphQuery.isError && (
            <p className="text-sm text-destructive">
              {t('preferences.workflow.loadError')}
            </p>
          )}

          {graphQuery.data && (
            <>
              <SettingsSection title={t('preferences.workflow.states')}>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {t('preferences.workflow.statesDescription')}
                  </p>
                  {isAdmin && (
                    <Button size="sm" onClick={() => setCreateStateOpen(true)}>
                      <Plus className="mr-1 h-4 w-4" />
                      {t('preferences.workflow.addState')}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {states.map(state => (
                    <StateRow
                      key={state.id}
                      state={state}
                      onClick={() => setSelectedStateId(state.id)}
                    />
                  ))}
                </div>
              </SettingsSection>

              <SettingsSection title={t('preferences.workflow.transitions')}>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    {t('preferences.workflow.transitionsDescription')}
                  </p>
                  {isAdmin && (
                    <Button
                      size="sm"
                      disabled={states.length < 2}
                      onClick={() => setCreateTransitionOpen(true)}
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      {t('preferences.workflow.addTransition')}
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {transitions.map(transition => (
                    <TransitionRow
                      key={transition.id}
                      transition={transition}
                      fromLabel={stateLabelById(transition.from_state_id)}
                      toLabel={stateLabelById(transition.to_state_id)}
                      onClick={() => setSelectedTransitionId(transition.id)}
                    />
                  ))}
                </div>
              </SettingsSection>
            </>
          )}
        </TabsContent>
      </Tabs>

      <CreateStateDialog
        open={createStateOpen}
        onOpenChange={setCreateStateOpen}
        scope={scope}
        onSubmit={body => createState.mutate(body)}
        isPending={createState.isPending}
      />
      <CreateTransitionDialog
        open={createTransitionOpen}
        onOpenChange={setCreateTransitionOpen}
        states={states}
        onSubmit={body => createTransition.mutate(body)}
        isPending={createTransition.isPending}
      />

      {selectedState && (
        <StateDetailSheet
          state={selectedState}
          isAdmin={isAdmin}
          open={selectedStateId !== null}
          onOpenChange={open => !open && setSelectedStateId(null)}
          onSave={body => updateState.mutate({ id: selectedState.id, body })}
          onDelete={() => deleteState.mutate(selectedState.id)}
          isSaving={updateState.isPending}
          isDeleting={deleteState.isPending}
        />
      )}
      {selectedTransition && (
        <TransitionDetailSheet
          transition={selectedTransition}
          stateLabel={stateLabelById}
          isAdmin={isAdmin}
          open={selectedTransitionId !== null}
          onOpenChange={open => !open && setSelectedTransitionId(null)}
          onSave={body =>
            updateTransition.mutate({ id: selectedTransition.id, body })
          }
          onDelete={() => deleteTransition.mutate(selectedTransition.id)}
          isSaving={updateTransition.isPending}
          isDeleting={deleteTransition.isPending}
        />
      )}
    </div>
  )
}

function StateRow({
  state,
  onClick,
}: {
  state: WorkflowState
  onClick: () => void
}) {
  const { t } = useTranslation()
  const notYetReachable = state.usage_count === 0 && !state.is_builtin

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg border p-3 text-left transition-opacity hover:bg-muted/40',
        !state.is_active && 'opacity-60'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border"
          style={{ backgroundColor: state.color ?? undefined }}
        />
        <span className="truncate font-medium">{state.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {state.slug}
        </span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t(`preferences.workflow.category.${state.category}`)}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {state.is_builtin && (
          <Badge variant="outline" className="text-[10px]">
            {t('preferences.workflow.builtin')}
          </Badge>
        )}
        {!state.is_active && (
          <Badge variant="secondary" className="text-[10px]">
            {t('preferences.workflow.inactive')}
          </Badge>
        )}
        {notYetReachable && (
          <Badge variant="outline" className="text-[10px]">
            {t('preferences.workflow.notYetReachable')}
          </Badge>
        )}
        <Badge variant="secondary" className="text-[10px]">
          {t('preferences.workflow.usage', { count: state.usage_count })}
        </Badge>
      </div>
    </button>
  )
}

function TransitionRow({
  transition,
  fromLabel,
  toLabel,
  onClick,
}: {
  transition: WorkflowTransition
  fromLabel: string
  toLabel: string
  onClick: () => void
}) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg border p-3 text-left transition-opacity hover:bg-muted/40',
        !transition.is_active && 'opacity-60'
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">
          {transition.label || transition.verb}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {fromLabel} → {toLabel}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {transition.is_builtin && (
          <Badge variant="outline" className="text-[10px]">
            {t('preferences.workflow.builtin')}
          </Badge>
        )}
        {!transition.is_active && (
          <Badge variant="secondary" className="text-[10px]">
            {t('preferences.workflow.inactive')}
          </Badge>
        )}
        {transition.requirements.length > 0 && (
          <Badge variant="secondary" className="text-[10px]">
            {t('preferences.workflow.requirementsCount', {
              count: transition.requirements.length,
            })}
          </Badge>
        )}
      </div>
    </button>
  )
}

export default WorkflowPane
