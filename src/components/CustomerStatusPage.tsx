/**
 * Phase 29 — Plan 29-04: CustomerStatusPage
 *
 * Three co-located functions in one file (plan L212-232 mandate):
 *
 *   1. CustomerListView          — full list-view implementation. All list-view
 *                                  hooks (useState, useEffect, useQuery, multiple
 *                                  useUIStore selector reads) live at the TOP of
 *                                  this function, unconditionally. No conditional
 *                                  returns above the hooks block.
 *
 *   2. CustomerDetailView        — minimal placeholder. Single hook reads
 *                                  customerDetailTargetId via selector syntax,
 *                                  then renders `<div data-testid="customer-
 *                                  detail-placeholder">…</div>`. Plan 29-05
 *                                  replaces ONLY this function's body with the
 *                                  real header + orders table.
 *
 *   3. CustomerStatusPage        — exported router. Exactly ONE hook call
 *                                  (useUIStore for activeSubSection) followed by
 *                                  ONE ternary return. Nothing else. This shape
 *                                  is what satisfies `react-hooks/rules-of-hooks`
 *                                  and `react-compiler/react-compiler` (both
 *                                  `error` per eslint.config.js:33-34) — every
 *                                  other hook lives inside a leaf component
 *                                  where it is always reached unconditionally.
 *
 * Selector-syntax mandate (AGENTS.md): every useUIStore call uses the
 *   `state => state.x` form. Destructuring is ast-grep enforced.
 *
 * Server-side filters only (CONTEXT D-07, T-29-03): no Array.filter over the
 *   customers list. The backend owns search, page, and include_test_emails.
 *
 * hideTestAccounts inversion (CONTEXT D-08, RESEARCH §11 #6): the store field
 *   is `hideTestAccounts` (UI-positive, default true). The backend takes
 *   `include_test_emails`. The inversion is at the call site: `!hideTestAccounts`.
 *
 * No manual useMemo/useCallback in this plan. React Compiler handles
 *   memoization for the list view's render output.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  PackageX,
  Search,
  User,
  Users,
  X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  getExplorerCustomerById,
  getExplorerCustomers,
  getExplorerOrdersByCustomer,
  getExplorerStatus,
  type ExplorerCustomer,
  type ExplorerCustomersResponse,
  type ExplorerOrder,
  type SenaiteLookupResult,
} from '@/lib/api'
import {
  API_PROFILE_CHANGED_EVENT,
  getActiveEnvironmentName,
  getWordpressUrl,
} from '@/lib/api-profiles'
import { useUIStore } from '@/store/ui-store'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDate } from '@/components/explorer/helpers'
import { OrderRow } from '@/components/explorer/OrderRow'
import { useOrderSlaStatuses } from '@/services/order-sla'
import { useSenaiteLookupMap } from '@/services/senaite-lookup-map'
import { useEffectiveReadSource } from '@/lib/read-source'

const PER_PAGE = 50

/**
 * List view — the full Phase 29 customers list implementation.
 *
 * All hooks live at the top of this function, unconditional. The disconnected
 * branch and error branch return JSX below the hooks; none of them are
 * conditional returns BEFORE a hook call.
 */
function CustomerListView() {
  // --- Store reads (selector syntax mandatory — ast-grep enforced) ---
  const customerSearchTerm = useUIStore(state => state.customerSearchTerm)
  const customerListPage = useUIStore(state => state.customerListPage)
  const hideTestAccounts = useUIStore(state => state.hideTestAccounts)
  const setCustomerListPage = useUIStore(state => state.setCustomerListPage)
  const setHideTestAccounts = useUIStore(state => state.setHideTestAccounts)
  const setSearchAndResetPage = useUIStore(
    state => state.setSearchAndResetPage
  )
  const navigateToCustomer = useUIStore(state => state.navigateToCustomer)

  // --- Local UI state ---
  const [envName, setEnvName] = useState(() => getActiveEnvironmentName())
  const [localInput, setLocalInput] = useState(customerSearchTerm)
  // Table scroll container — UI-SPEC L313 requires scroll-to-top on page change
  const tableScrollRef = useRef<HTMLDivElement>(null)

  // envName listener — mirrors OrderStatusPage:563-568
  useEffect(() => {
    const handleProfileChange = () => setEnvName(getActiveEnvironmentName())
    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
    return () =>
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
  }, [])

  // Debounce: 300ms after the last keystroke commits to the store. The store
  // action `setSearchAndResetPage` atomically updates BOTH `customerSearchTerm`
  // and `customerListPage=0` in a single set() call to avoid the 1-render race
  // where the query key would briefly carry (new search, old page).
  useEffect(() => {
    if (localInput === customerSearchTerm) return
    const timer = setTimeout(() => {
      setSearchAndResetPage(localInput)
    }, 300)
    return () => clearTimeout(timer)
  }, [localInput, customerSearchTerm, setSearchAndResetPage])

  // --- Queries ---
  const { data: status } = useQuery({
    queryKey: ['explorer', 'status', envName],
    queryFn: getExplorerStatus,
    staleTime: 0,
  })

  const {
    data: customersData,
    isLoading: customersLoading,
    error: customersError,
    refetch: refetchCustomers,
  } = useQuery({
    queryKey: [
      'explorer',
      'customers',
      customerSearchTerm,
      customerListPage,
      hideTestAccounts,
      envName,
    ],
    // !hideTestAccounts is the mandatory inversion — store field is UI-positive
    // ("hide them by default"), backend param is `include_test_emails` (the
    // negation).
    queryFn: () =>
      getExplorerCustomers(
        customerSearchTerm || undefined,
        customerListPage,
        PER_PAGE,
        !hideTestAccounts
      ),
    enabled: status?.connected === true,
    staleTime: 60_000,
  })

  // --- Derived (no client-side filter — D-07, T-29-03) ---
  const customers = customersData?.customers ?? []
  const isConnected = status?.connected === true
  const hasError = customersError != null

  // Subtitle copy — D-21. total_count is unconditionally returned by the
  // backend in practice, but the fallback honors the optional contract.
  let subtitle: string
  if (customersData?.total_count !== undefined) {
    subtitle = customerSearchTerm
      ? `${customersData.total_count} customers matching "${customerSearchTerm}"`
      : `${customersData.total_count} customers`
  } else {
    subtitle = `${customers.length} customers on this page`
  }

  // Page navigation — sets the new page index and smoothly scrolls the table
  // container back to the top so the user sees row 1 of the new page without
  // a manual scroll (UI-SPEC L313).
  const goToPage = (next: number) => {
    setCustomerListPage(next)
    tableScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header row — icon circle + title */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold">Customers</h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      {/* Disconnected banner — inlined from OrderStatusPage:825-834 (D-16) */}
      {status && !status.connected && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>
                Failed to connect to database: {status.error}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Controls row — search + toggle */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={localInput}
            onChange={e => setLocalInput(e.target.value)}
            placeholder="Search by name or email…"
            className="pl-9 pr-9"
          />
          {localInput && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
              onClick={() => {
                setLocalInput('')
                setSearchAndResetPage('')
              }}
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap cursor-pointer ml-auto">
          <Checkbox
            checked={hideTestAccounts}
            onCheckedChange={checked => setHideTestAccounts(checked === true)}
          />
          {hideTestAccounts ? 'Hide test accounts' : 'Showing test accounts'}
        </label>
      </div>

      {/* Error alert — D-18 + T-29-02 PII gate. import.meta.env.PROD is replaced
          at build time by Vite; the dev branch is dead-code-eliminated in
          production bundles. */}
      {hasError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load customers</AlertTitle>
          <AlertDescription>
            {import.meta.env.PROD
              ? 'Check your connection and try again.'
              : String(
                  customersError instanceof Error
                    ? customersError.message
                    : customersError
                )}
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => refetchCustomers()}
            aria-label="Retry loading customers"
          >
            Retry
          </Button>
        </Alert>
      )}

      {/* Customers card */}
      <Card>
        <CardContent className="p-0">
          <div ref={tableScrollRef} className="overflow-auto max-h-[850px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card border-b">
                <tr className="text-left">
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap">
                    Display Name
                  </th>
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap">
                    Email
                  </th>
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap text-right">
                    Total Orders
                  </th>
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap text-right">
                    Outstanding
                  </th>
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap text-right">
                    Total COAs
                  </th>
                  <th className="py-2 px-3 text-xs font-semibold uppercase text-muted-foreground whitespace-nowrap">
                    Most Recent
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {/* Loading: skeletons only when connected AND a fetch is in
                    flight. Bare `customersLoading` would still be false when
                    `enabled:false` (TanStack reports isLoading:false then), but
                    making the gate explicit removes any ambiguity for the
                    disconnected test. */}
                {isConnected &&
                  customersLoading &&
                  !hasError &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={`skeleton-${i}`} data-testid="customer-row-skeleton">
                      {Array.from({ length: 6 }).map((__, j) => (
                        <td key={j} className="py-3 px-3">
                          <Skeleton className="h-4 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))}

                {/* Empty state — connected + no error + no data */}
                {isConnected &&
                  !customersLoading &&
                  !hasError &&
                  customers.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-16">
                        <div className="flex flex-col items-center text-center">
                          <Users className="h-8 w-8 text-muted-foreground/40 mb-2" />
                          <p className="text-sm font-medium text-muted-foreground">
                            No customers found
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {customerSearchTerm
                              ? `No customers match "${customerSearchTerm}". Try a different search.`
                              : 'No customer records available yet.'}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}

                {/* Data rows — NO Array.filter over `customers` (T-29-03).
                    The backend owns search + include_test_emails. */}
                {isConnected &&
                  !customersLoading &&
                  !hasError &&
                  customers.length > 0 &&
                  customers.map(customer => (
                    <CustomerRow
                      key={
                        customer.customer_id !== null
                          ? `c-${customer.customer_id}`
                          : `g-${customer.email}`
                      }
                      customer={customer}
                      onNavigate={navigateToCustomer}
                    />
                  ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination — UI-SPEC L202-207. Left subtitle shows the per-page
          range ({start}–{end} of {total}) when total_count is available, else
          falls back to "Page {N}". Right side holds Prev / Page indicator /
          Next. Page change scrolls the table container to top (UI-SPEC L313). */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-sm text-muted-foreground">
          {customersData?.total_count !== undefined && customers.length > 0
            ? `${customerListPage * PER_PAGE + 1}–${customerListPage * PER_PAGE + customers.length} of ${customersData.total_count}`
            : `Page ${customerListPage + 1}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(customerListPage - 1)}
            disabled={customerListPage === 0 || customersLoading}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-sm text-muted-foreground min-w-[60px] text-center">
            Page {customerListPage + 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(customerListPage + 1)}
            disabled={customers.length < PER_PAGE || customersLoading}
            aria-label="Next page"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * One customer row. Extracted into its own component so the row's keyboard
 * handler closure captures one customer (avoiding the per-row recreation that
 * React Compiler would otherwise have to memoize). Guests (customer_id === null)
 * are non-keyboard-focusable, non-clickable, and labeled "— (Guest)".
 */
function CustomerRow({
  customer,
  onNavigate,
}: {
  customer: ExplorerCustomer
  onNavigate: (id: number) => void
}) {
  const customerId = customer.customer_id
  const isRegistered = customerId !== null

  return (
    <tr
      tabIndex={isRegistered ? 0 : -1}
      onClick={isRegistered ? () => onNavigate(customerId) : undefined}
      onKeyDown={
        isRegistered
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigate(customerId)
              }
            }
          : undefined
      }
      className={cn(
        isRegistered
          ? 'cursor-pointer hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:outline-none'
          : 'cursor-default'
      )}
    >
      <td className="py-3 px-3">
        {isRegistered ? (
          <span className="font-medium text-sm">{customer.display_name}</span>
        ) : (
          <span className="text-sm text-muted-foreground">— (Guest)</span>
        )}
      </td>
      <td className="py-3 px-3 text-sm text-muted-foreground">
        {customer.email}
      </td>
      <td className="py-3 px-3 text-sm text-right">{customer.total_orders}</td>
      <td
        className={cn(
          'py-3 px-3 text-sm text-right',
          customer.outstanding_orders > 0
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground'
        )}
      >
        {customer.outstanding_orders}
      </td>
      <td className="py-3 px-3 text-sm text-right">{customer.total_coas}</td>
      <td className="py-3 px-3 text-sm text-muted-foreground">
        {formatDate(customer.most_recent_order_at)}
      </td>
    </tr>
  )
}

/**
 * Customer detail view — Plan 29-05 implementation.
 *
 * Reuses the extracted OrderRow + SampleCard (Plan 29-00) and the SENAITE
 * fan-out pattern verbatim from OrderStatusPage:619-665.
 *
 * Header data source (Plan 29-05 §step 3, option b): reads the customer record
 * from the list-query cache via `queryClient.getQueriesData`. No new endpoint
 * is added; falls back to `Customer #{id}` when the list was not visited first.
 *
 * useMemo invariants — LOAD-BEARING (RESEARCH §11 #1, PATTERNS):
 *   - sortedOrders   — feeds OrderRow.map; identity stability avoids extra
 *                      OrderRow renders.
 *   - sampleLookupMap — from useSenaiteLookupMap(orders); feeds
 *                      useOrderSlaStatuses + CustomerOrdersTab's
 *                      sampleLookupMap prop.
 *
 * Selector syntax mandate (AGENTS.md): every useUIStore call uses
 * `state => state.x`. ast-grep enforces.
 *
 * Back navigation (D-11): a single `navigateToCustomers()` call atomically
 * sets activeSubSection='customers' AND clears customerDetailTargetId. The
 * store action is the source of truth — see src/store/ui-store.ts:317-326.
 */
function CustomerDetailView() {
  // --- Store reads (selector syntax mandatory — ast-grep enforced) ---
  const customerDetailTargetId = useUIStore(
    state => state.customerDetailTargetId
  )
  const navigateToCustomers = useUIStore(state => state.navigateToCustomers)
  // Phase 30 — Task 6: detail-view tab selection
  const customerDetailTab = useUIStore(state => state.customerDetailTab)
  const setCustomerDetailTab = useUIStore(state => state.setCustomerDetailTab)
  // UX revision: per-customer order search uses THREE independent axes
  // (order_number, sample_id, analyte) that are AND-combined server-side.
  // - `customerOrderSearch` is the committed (post-debounce) state per axis.
  // - `setCustomerOrderSearchField(field, value)` writes ONE slot at a time
  //   from the corresponding input's debounced effect.
  // - `setCustomerOrderSearchReset()` clears all three slots (used by the
  //   Clear button and by navigateToCustomers).
  //
  // Selector syntax is mandatory (ast-grep enforced — no destructuring of
  // useUIStore() itself; dot-access into the returned object is fine).
  const customerOrderSearch = useUIStore(state => state.customerOrderSearch)
  const setCustomerOrderSearchField = useUIStore(
    state => state.setCustomerOrderSearchField
  )
  const setCustomerOrderSearchReset = useUIStore(
    state => state.setCustomerOrderSearchReset
  )

  // --- envName tracking (mirrors OrderStatusPage:1079) ---
  const [envName, setEnvName] = useState(() => getActiveEnvironmentName())
  useEffect(() => {
    const handleProfileChange = () => setEnvName(getActiveEnvironmentName())
    window.addEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
    return () =>
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, handleProfileChange)
  }, [])

  // --- Connection status (gates the orders query) ---
  const { data: status } = useQuery({
    queryKey: ['explorer', 'status', envName],
    queryFn: getExplorerStatus,
    staleTime: 0,
  })
  const isConnected = status?.connected === true

  // --- Header data: read the customer record from the list-query cache
  // (Plan 29-05 §3 option b). T-29-05-new: cache reads are envName-scoped via
  // the predicate below — the list-query writes keys shaped
  // ['explorer','customers',search,page,hideTestAccounts,envName] (queryKey[5]),
  // so the predicate filters out any cached pages from a previous env profile
  // before the find-by-id walk. Fallback "Customer #{id}" is rendered when the
  // user lands on detail without visiting the list first (defensible degraded
  // state; not a regression).
  const queryClient = useQueryClient()
  const headerCustomer: ExplorerCustomer | null = useMemo(() => {
    if (customerDetailTargetId === null) return null
    const cached = queryClient.getQueriesData<ExplorerCustomersResponse>({
      queryKey: ['explorer', 'customers'],
      predicate: query => query.queryKey[5] === envName,
    })
    for (const [, value] of cached) {
      if (!value?.customers) continue
      const hit = value.customers.find(
        c => c.customer_id === customerDetailTargetId
      )
      if (hit) return hit
    }
    return null
  }, [customerDetailTargetId, queryClient, envName])

  // Authoritative single-customer fetch for cold loads (deep-link / refresh).
  // The list cache is empty when you land here directly via the URL, so
  // headerCustomer is null — fall back to GET /explorer/customers/{id}
  // (wc_customers + aggregate stats). Disabled once the list cache can satisfy
  // the lookup, so navigating from the list never triggers this extra fetch.
  const { data: fetchedCustomer } = useQuery({
    queryKey: ['explorer', 'customer', customerDetailTargetId, envName],
    queryFn: () => {
      if (customerDetailTargetId === null) {
        throw new Error('customerDetailTargetId unexpectedly null')
      }
      return getExplorerCustomerById(customerDetailTargetId)
    },
    enabled:
      isConnected &&
      customerDetailTargetId !== null &&
      headerCustomer === null,
    staleTime: 60_000,
  })

  // Header source of truth: list-cache hit first, then the cold-load fetch.
  const resolvedCustomer: ExplorerCustomer | null =
    headerCustomer ?? fetchedCustomer ?? null

  // --- Orders query (D-09 + UX revision: three-axis search + envName) ---
  // QueryKey shape:
  //   ['explorer','orders','by-customer', id,
  //    order_number, sample_id, analyte, 'open_first', envName]
  // - Each search axis participates in the key so distinct queries occupy
  //   distinct cache slots (no bleed across filter combinations).
  // - sort is fixed to 'open_first' but reserved in the key so later phases
  //   can parameterize without invalidating existing cache writes.
  // - envName lives at the LAST position (index 8) — T-29-05-new mitigation
  //   scope for any future cross-env predicate. Do NOT move it.
  // The per-axis 2-char minimum gate lives in the API client
  // (src/lib/api.ts:getExplorerOrdersByCustomer); the call site forwards
  // every slot and lets the client drop short values per axis.
  const {
    data: orders,
    isLoading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useQuery({
    queryKey: [
      'explorer',
      'orders',
      'by-customer',
      customerDetailTargetId,
      customerOrderSearch.order_number,
      customerOrderSearch.sample_id,
      customerOrderSearch.analyte,
      'open_first',
      envName,
    ],
    queryFn: () => {
      // `enabled` guarantees customerDetailTargetId !== null at call time;
      // narrow explicitly rather than asserting non-null (eslint forbids `!`).
      if (customerDetailTargetId === null) {
        throw new Error('customerDetailTargetId unexpectedly null')
      }
      return getExplorerOrdersByCustomer(
        customerDetailTargetId,
        {
          order_number: customerOrderSearch.order_number,
          sample_id: customerOrderSearch.sample_id,
          analyte: customerOrderSearch.analyte,
        },
        'open_first',
        0,
        50
      )
    },
    enabled: isConnected && customerDetailTargetId !== null,
    staleTime: 30_000,
  })

  // --- Client-side sort (RESEARCH §12 Q4 — load-bearing useMemo) ---
  // /explorer/orders has no ?sort= param; sort here. Open orders first
  // (completed_at IS NULL), then created_at DESC.
  const sortedOrders = useMemo<ExplorerOrder[]>(() => {
    if (!orders) return []
    return [...orders].sort((a, b) => {
      const aOpen = a.completed_at === null
      const bOpen = b.completed_at === null
      if (aOpen !== bOpen) return aOpen ? -1 : 1
      return (
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    })
  }, [orders])

  // Per-sample SENAITE lookup map (shared hook — see useSenaiteLookupMap).
  // Resolved from the 'sample_details' two-tier read-source setting — same
  // mechanism as SampleDetails.tsx; defaults to 'senaite' (no behavior
  // change until the Handler flips it).
  const { effective: sampleDetailsSource } = useEffectiveReadSource('sample_details')
  const { sampleLookupMap } = useSenaiteLookupMap(orders ?? [], sampleDetailsSource)

  // wordpressHost is read here and threaded into CustomerOrdersTab (the
  // derived render flags hasError/hasOrders/showLoading/showEmpty now live
  // inside CustomerOrdersTab — Phase 30 Task 6).
  const wordpressHost = getWordpressUrl()

  // --- Header text resolution (cache record, cold-load fetch, then fallback) ---
  const displayName =
    resolvedCustomer?.display_name ?? `Customer #${customerDetailTargetId}`
  const email = resolvedCustomer?.email ?? null
  const company = resolvedCustomer?.company_name ?? null
  // display_name follows the list convention (= email), so suppress the
  // secondary email line when it would just duplicate the name.
  const secondaryEmail = email && email !== displayName ? email : null

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Back link — D-11. Use a plain <button> (not shadcn Button) per
          UI-SPEC §Back Navigation (matches the text-primary link pattern). */}
      <div>
        <button
          type="button"
          className="text-sm text-primary hover:underline mb-4"
          onClick={() => navigateToCustomers()}
        >
          ← Back to Customers
        </button>
      </div>

      {/* Disconnected banner — inlined verbatim from the list view (D-16). */}
      {status && !status.connected && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>Failed to connect to database: {status.error}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Customer header card — compact single row (identity left, stats right).
          py-0 overrides the shadcn Card root's default py-6 so the only vertical
          padding is CardContent's py-2. */}
      <Card className="py-0">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2">
          {/* Identity — single line: name, then muted email/company inline */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 shrink-0">
              <User className="h-3.5 w-3.5 text-primary" />
            </div>
            <span className="text-sm font-semibold truncate">{displayName}</span>
            {secondaryEmail && (
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {secondaryEmail}
              </span>
            )}
            {company && (
              <span className="text-xs text-muted-foreground italic whitespace-nowrap">
                {company}
              </span>
            )}
          </div>

          {/* Stats — inline, pushed right on wider viewports */}
          {resolvedCustomer && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs sm:ml-auto">
              <span>
                <span className="text-muted-foreground">Orders </span>
                <span className="font-semibold">
                  {resolvedCustomer.total_orders}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Outstanding </span>
                <span
                  className={cn(
                    'font-semibold',
                    resolvedCustomer.outstanding_orders > 0
                      ? 'text-amber-600 dark:text-amber-400'
                      : ''
                  )}
                >
                  {resolvedCustomer.outstanding_orders}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">COAs </span>
                <span className="font-semibold">
                  {resolvedCustomer.total_coas}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Recent </span>
                <span className="font-semibold">
                  {formatDate(resolvedCustomer.most_recent_order_at)}
                </span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 30 — Task 6: Tabs wrap everything below the header card.
          Customer Orders is the default. Dashboard is a placeholder. */}
      <Tabs
        value={customerDetailTab}
        onValueChange={v =>
          setCustomerDetailTab(v as 'orders' | 'dashboard')
        }
        className="mt-4"
      >
        <TabsList>
          <TabsTrigger value="orders">Customer Orders</TabsTrigger>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="mt-4">
          <CustomerOrdersTab
            orders={sortedOrders}
            ordersLoading={ordersLoading}
            ordersError={ordersError}
            refetchOrders={refetchOrders}
            isConnected={isConnected}
            wordpressHost={wordpressHost}
            sampleLookupMap={sampleLookupMap}
            customerOrderSearch={customerOrderSearch}
            setCustomerOrderSearchField={setCustomerOrderSearchField}
            setCustomerOrderSearchReset={setCustomerOrderSearchReset}
          />
        </TabsContent>
        <TabsContent value="dashboard" className="mt-4">
          <CustomerDashboardPlaceholder />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * UX revision — Customer Orders tab body (three-input AND search).
 *
 * The single Select+Input search has been replaced by THREE labeled inputs
 * laid out side-by-side: Order #, Sample ID, Analyte. Each input has its own
 * local state, its own 300ms debounce, and dispatches via
 * `setCustomerOrderSearchField(<that axis>, value)` — slots are independent
 * and AND-combined server-side.
 *
 * Debounce contract (one per axis, mirrors CustomerListView's pattern):
 *   - local state holds the immediate keystroke value for that axis
 *   - useEffect schedules a 300ms setTimeout; cleanup clears on re-fire
 *   - timer body calls `setCustomerOrderSearchField` ONLY when the local
 *     value has diverged from the committed store value (avoids no-op
 *     dispatches and an extra render after the commit settles).
 *
 * The 2-char minimum gate lives in the API client
 * (src/lib/api.ts:getExplorerOrdersByCustomer); each axis is independently
 * gated there. This component forwards every committed value to the store;
 * the api.ts gate decides whether to put it on the wire.
 *
 * `searchActive` reflects the COMMITTED store values (any non-empty axis),
 * not the local input states. This keeps the empty-state echo and
 * OrderRow.defaultExpanded propagation in lock-step with what was actually
 * dispatched (the 300ms debounce window is the only delay).
 *
 * Clear button: appears when ANY of the three committed slots is non-empty.
 * On click it dispatches `setCustomerOrderSearchReset()` AND wipes all three
 * local input states (the local resets are what cancel any in-flight
 * debounce — the effect bails when local === committed).
 */
function CustomerOrdersTab({
  orders,
  ordersLoading,
  ordersError,
  refetchOrders,
  isConnected,
  wordpressHost,
  sampleLookupMap,
  customerOrderSearch,
  setCustomerOrderSearchField,
  setCustomerOrderSearchReset,
}: {
  orders: ExplorerOrder[]
  ordersLoading: boolean
  ordersError: unknown
  refetchOrders: () => void
  isConnected: boolean
  wordpressHost: string
  sampleLookupMap: Map<
    string,
    {
      data?: SenaiteLookupResult
      isLoading: boolean
      isError: boolean
    }
  >
  customerOrderSearch: {
    order_number: string
    sample_id: string
    analyte: string
  }
  setCustomerOrderSearchField: (
    field: 'order_number' | 'sample_id' | 'analyte',
    value: string
  ) => void
  setCustomerOrderSearchReset: () => void
}) {
  // One local state slot per axis. Seed from the committed store value so a
  // remount / back-nav doesn't blow away the in-flight search term.
  const [orderNumberInput, setOrderNumberInput] = useState(
    customerOrderSearch.order_number
  )
  const [sampleIdInput, setSampleIdInput] = useState(
    customerOrderSearch.sample_id
  )
  const [analyteInput, setAnalyteInput] = useState(customerOrderSearch.analyte)

  // 300ms debounce, per axis. Each effect depends ONLY on its own axis (local
  // + committed) — touching another axis won't reschedule this timer.
  useEffect(() => {
    if (orderNumberInput === customerOrderSearch.order_number) return
    const handle = setTimeout(() => {
      setCustomerOrderSearchField('order_number', orderNumberInput)
    }, 300)
    return () => clearTimeout(handle)
  }, [
    orderNumberInput,
    customerOrderSearch.order_number,
    setCustomerOrderSearchField,
  ])

  useEffect(() => {
    if (sampleIdInput === customerOrderSearch.sample_id) return
    const handle = setTimeout(() => {
      setCustomerOrderSearchField('sample_id', sampleIdInput)
    }, 300)
    return () => clearTimeout(handle)
  }, [
    sampleIdInput,
    customerOrderSearch.sample_id,
    setCustomerOrderSearchField,
  ])

  useEffect(() => {
    if (analyteInput === customerOrderSearch.analyte) return
    const handle = setTimeout(() => {
      setCustomerOrderSearchField('analyte', analyteInput)
    }, 300)
    return () => clearTimeout(handle)
  }, [
    analyteInput,
    customerOrderSearch.analyte,
    setCustomerOrderSearchField,
  ])

  // searchActive: any committed (post-debounce) axis non-empty. Drives the
  // empty-state echo, OrderRow.defaultExpanded, and the Clear button mount.
  const searchActive = Boolean(
    customerOrderSearch.order_number ||
      customerOrderSearch.sample_id ||
      customerOrderSearch.analyte
  )

  // highlightSampleId: sample-ID highlight forwarded to OrderRow only when
  // the committed sample_id slot has at least 2 chars (matches the API gate
  // so we don't pretend to highlight a non-filtered search).
  const highlightSampleId =
    searchActive && customerOrderSearch.sample_id.length >= 2
      ? customerOrderSearch.sample_id
      : undefined

  // Empty-state echo: build "Order #: \"3001\" AND Sample ID: \"P-0001\""
  // from whichever committed axes are non-empty. Each fragment is rendered
  // separately so the labels and values keep their typography contract.
  const activeFilters: { label: string; value: string }[] = []
  if (customerOrderSearch.order_number) {
    activeFilters.push({
      label: 'Order #',
      value: customerOrderSearch.order_number,
    })
  }
  if (customerOrderSearch.sample_id) {
    activeFilters.push({
      label: 'Sample ID',
      value: customerOrderSearch.sample_id,
    })
  }
  if (customerOrderSearch.analyte) {
    activeFilters.push({
      label: 'Analyte',
      value: customerOrderSearch.analyte,
    })
  }

  const hasError = ordersError != null
  const hasOrders = orders.length > 0
  const showLoading = ordersLoading && isConnected
  const showEmpty = isConnected && !showLoading && !hasError && !hasOrders

  // D2: order-aggregated SLA verdicts for the table-view SLA column.
  const orderSla = useOrderSlaStatuses(orders, sampleLookupMap)

  const handleClearAll = () => {
    setCustomerOrderSearchReset()
    setOrderNumberInput('')
    setSampleIdInput('')
    setAnalyteInput('')
  }

  return (
    <>
      {/* Search header — three labeled inputs side-by-side, AND-combined */}
      <div className="flex items-end gap-3 mb-3">
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="customer-orders-search-order-number">Order #</Label>
          <Input
            id="customer-orders-search-order-number"
            aria-label="Order #"
            value={orderNumberInput}
            onChange={e => setOrderNumberInput(e.target.value)}
            placeholder="e.g., 3001"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="customer-orders-search-sample-id">Sample ID</Label>
          <Input
            id="customer-orders-search-sample-id"
            aria-label="Sample ID"
            value={sampleIdInput}
            onChange={e => setSampleIdInput(e.target.value)}
            placeholder="e.g., P-0001"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Label htmlFor="customer-orders-search-analyte">Analyte</Label>
          <Input
            id="customer-orders-search-analyte"
            aria-label="Analyte"
            value={analyteInput}
            onChange={e => setAnalyteInput(e.target.value)}
            placeholder="e.g., BPC-157"
          />
        </div>
        {searchActive && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearAll}
            aria-label="Clear search"
          >
            Clear search
          </Button>
        )}
      </div>

      {/* Error alert — D-18 + T-29-02 PII gate */}
      {hasError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load customer</AlertTitle>
          <AlertDescription>
            {import.meta.env.PROD
              ? 'Check your connection and try again.'
              : String(
                  ordersError instanceof Error
                    ? ordersError.message
                    : ordersError
                )}
          </AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => refetchOrders()}
            aria-label="Retry loading customer"
          >
            Retry
          </Button>
        </Alert>
      )}

      {/* Orders card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Orders</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            {searchActive ? 'Search results' : 'Open orders first'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {showLoading && (
            <div className="divide-y divide-border/50 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={`detail-skel-${i}`}
                  data-testid="detail-order-skeleton"
                  className="py-2"
                >
                  <Skeleton className="h-14 w-full" />
                </div>
              ))}
            </div>
          )}
          {showEmpty && !searchActive && (
            <div className="flex flex-col items-center text-center py-12">
              <PackageX className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-muted-foreground">
                No orders for this customer
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Orders will appear here when this customer places them.
              </p>
            </div>
          )}
          {showEmpty && searchActive && activeFilters.length > 0 && (
            <div className="flex flex-col items-center text-center py-12">
              <PackageX className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-medium text-muted-foreground">
                {`No orders match ${activeFilters
                  .map(f => `${f.label}: "${f.value}"`)
                  .join(' AND ')}`}
              </p>
            </div>
          )}
          {isConnected && !showLoading && !hasError && hasOrders && (
            // No max-height / vertical scroll — the list flows into the page's
            // scroll container (MainWindow's flex-1 overflow-auto), so the whole
            // page scrolls as one. overflow-x-auto keeps wide rows contained.
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-card border-b">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Order ID
                    </th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Email
                    </th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Progress
                    </th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Created
                    </th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Timing
                    </th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">SLA</th>
                    <th className="py-2 px-3 font-medium whitespace-nowrap">
                      Sample Details
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {orders.map(order => (
                    <OrderRow
                      key={order.id}
                      order={order}
                      wordpressHost={wordpressHost}
                      sampleLookupMap={sampleLookupMap}
                      activeAnalysisStates={[]}
                      defaultExpanded={searchActive ? true : undefined}
                      highlightSampleId={highlightSampleId}
                      showFinance
                      slaVerdict={orderSla.verdictByOrderId.get(order.order_id)}
                      sampleSlaStatusesMap={orderSla.sampleStatusesBySampleId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  )
}

/**
 * Phase 30 — Task 6: Dashboard tab placeholder.
 *
 * One-line "Coming soon" card. Phase 30 ships this empty; future phases will
 * replace its body with real per-customer analytics (revenue, orders/day,
 * average turnaround).
 */
function CustomerDashboardPlaceholder() {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <p className="text-sm text-muted-foreground">
          Coming soon — customer analytics (revenue, orders/day, average turnaround).
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * Router. Exactly ONE hook call followed by ONE ternary return. This shape is
 * what lets `react-hooks/rules-of-hooks` and `react-compiler/react-compiler`
 * pass — there are NO hooks below a conditional. Every other hook is inside a
 * leaf component, always reached unconditionally.
 */
export function CustomerStatusPage() {
  const activeSubSection = useUIStore(state => state.activeSubSection)
  return activeSubSection === 'customer-detail' ? (
    <CustomerDetailView />
  ) : (
    <CustomerListView />
  )
}
