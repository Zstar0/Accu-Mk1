/**
 * API client for communicating with the FastAPI backend.
 */

import { getApiBaseUrl } from './config'
import { getAuthToken } from '@/store/auth-store'

// Helper to get current API base URL (called dynamically)
const API_BASE_URL = () => getApiBaseUrl()

/**
 * Get headers with JWT Bearer token for authenticated requests.
 */
function getBearerHeaders(contentType?: string): HeadersInit {
  const token = getAuthToken()
  const headers: HeadersInit = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (contentType) {
    headers['Content-Type'] = contentType
  }
  return headers
}

/**
 * Generic typed fetch wrapper. Prefixes the app's API base URL, attaches
 * the JWT Bearer header (when a session exists), JSON-encodes bodies, and
 * throws on non-2xx responses. Use for new endpoints; the older ad-hoc
 * helpers above predate this wrapper and remain for compatibility.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const contentType =
    init.body !== undefined && init.body !== null ? 'application/json' : undefined
  const headers: HeadersInit = {
    ...getBearerHeaders(contentType),
    ...(init.headers ?? {}),
  }
  const response = await fetch(`${API_BASE_URL()}${path}`, { ...init, headers })
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

// --- Types ---

export interface HealthResponse {
  status: string
  version: string
}

export interface AuditLog {
  id: number
  timestamp: string
  operation: string
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export interface Setting {
  id: number
  key: string
  value: string
  updated_at: string
}

/**
 * Default column mappings structure.
 * Maps internal field names to CSV column headers.
 */
export interface ColumnMappings {
  peak_area: string
  retention_time: string
  compound_name: string
  [key: string]: string
}

// --- API Client ---

/**
 * Check if the backend is healthy and running.
 * Tries /health first (local backend), then /v1/health (Integration Service).
 */
export async function healthCheck(): Promise<HealthResponse> {
  const baseUrl = API_BASE_URL()

  // Try /health first (local backend)
  try {
    const response = await fetch(`${baseUrl}/health`)
    if (response.ok) {
      return response.json()
    }
  } catch (error) {
    console.error('/health check failed:', error)
  }

  // Try /v1/health (Integration Service)
  try {
    const response = await fetch(`${baseUrl}/v1/health`)
    if (response.ok) {
      return response.json()
    }
  } catch (error) {
    console.error('/v1/health check failed:', error)
  }

  throw new Error('Health check failed: Backend not reachable')
}

/**
 * Create an audit log entry.
 */
export async function createAuditLog(
  operation: string,
  entityType: string,
  entityId?: string,
  details?: Record<string, unknown>
): Promise<AuditLog> {
  try {
    const response = await fetch(`${API_BASE_URL()}/audit`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        operation,
        entity_type: entityType,
        entity_id: entityId ?? null,
        details: details ?? null,
      }),
    })
    if (!response.ok) {
      throw new Error(`Create audit log failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Create audit log error:', error)
    throw error
  }
}

/**
 * Get recent audit log entries.
 */
export async function getAuditLogs(limit = 50): Promise<AuditLog[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/audit?limit=${limit}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get audit logs failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get audit logs error:', error)
    throw error
  }
}

// --- Settings API ---

/**
 * Get all settings.
 */
export async function getSettings(): Promise<Setting[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/settings`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get settings failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get settings error:', error)
    throw error
  }
}

/**
 * Get a single setting by key.
 */
export async function getSetting(key: string): Promise<Setting> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/settings/${encodeURIComponent(key)}`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(`Get setting '${key}' failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get setting '${key}' error:`, error)
    throw error
  }
}

/**
 * Create or update a setting.
 */
export async function updateSetting(
  key: string,
  value: string
): Promise<Setting> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/settings/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify({ value }),
      }
    )
    if (!response.ok) {
      throw new Error(`Update setting '${key}' failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Update setting '${key}' error:`, error)
    throw error
  }
}

/**
 * Get column mappings as a typed object.
 * Parses the JSON value from the column_mappings setting.
 */
export async function getColumnMappings(): Promise<ColumnMappings> {
  const setting = await getSetting('column_mappings')
  return JSON.parse(setting.value) as ColumnMappings
}

/**
 * Update column mappings.
 * Stringifies the object before saving.
 */
export async function updateColumnMappings(
  mappings: ColumnMappings
): Promise<Setting> {
  return updateSetting('column_mappings', JSON.stringify(mappings))
}

// --- Import API ---

/**
 * Preview result from parsing a single file.
 */
export interface ParsePreview {
  filename: string
  headers: string[]
  rows: Record<string, string | number | null>[]
  row_count: number
  errors: string[]
}

/**
 * Summary of a created sample.
 */
export interface SampleSummary {
  id: number
  filename: string
  row_count: number
}

/**
 * Result from batch import operation.
 */
export interface ImportResult {
  job_id: number
  samples_created: number
  samples: SampleSummary[]
  errors: string[]
}

/**
 * Job record representing a batch import.
 */
export interface Job {
  id: number
  status: string
  source_directory: string | null
  created_at: string
  completed_at: string | null
}

/**
 * Sample record representing a single imported file.
 *
 * Status lifecycle: pending -> calculated -> approved/rejected
 */
export interface Sample {
  id: number
  job_id: number
  filename: string
  status: 'pending' | 'calculated' | 'approved' | 'rejected' | 'error' | string
  input_data: {
    rows: Record<string, string | number | null>[]
    headers: string[]
    row_count: number
  } | null
  rejection_reason: string | null
  created_at: string
}

/**
 * Preview a file parse without saving.
 * Returns parsed data for user review before import.
 */
export async function previewFile(filePath: string): Promise<ParsePreview> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/import/file?file_path=${encodeURIComponent(filePath)}`,
      {
        method: 'POST',
        headers: getBearerHeaders(),
      }
    )
    if (!response.ok) {
      throw new Error(`Preview file failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Preview file error:', error)
    throw error
  }
}

/**
 * Import multiple files as a batch.
 * Creates a Job and Sample records for each file.
 */
export async function importBatch(filePaths: string[]): Promise<ImportResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/import/batch`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ file_paths: filePaths }),
    })
    if (!response.ok) {
      throw new Error(`Import batch failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Import batch error:', error)
    throw error
  }
}

/**
 * File data for browser-based import.
 */
export interface FileData {
  filename: string
  headers: string[]
  rows: Record<string, string | number | null>[]
  row_count: number
}

/**
 * Import pre-parsed file data from browser.
 * Use this when files are selected via browser file input (no file path access).
 */
export async function importBatchData(
  files: FileData[]
): Promise<ImportResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/import/batch-data`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ files }),
    })
    if (!response.ok) {
      throw new Error(`Import batch data failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Import batch data error:', error)
    throw error
  }
}

// --- Jobs API ---

/**
 * Get recent jobs.
 */
export async function getJobs(limit = 50): Promise<Job[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/jobs?limit=${limit}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get jobs failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get jobs error:', error)
    throw error
  }
}

/**
 * Get a single job by ID.
 */
export async function getJob(jobId: number): Promise<Job> {
  try {
    const response = await fetch(`${API_BASE_URL()}/jobs/${jobId}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get job ${jobId} failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get job ${jobId} error:`, error)
    throw error
  }
}

/**
 * Get all samples for a job.
 */
export async function getJobSamples(jobId: number): Promise<Sample[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/jobs/${jobId}/samples`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get job ${jobId} samples failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get job ${jobId} samples error:`, error)
    throw error
  }
}

/**
 * Sample with flattened calculation results for batch review UI.
 * Includes purity, retention_time, and compound_id as top-level fields.
 */
export interface SampleWithResults {
  id: number
  job_id: number
  filename: string
  status: 'pending' | 'calculated' | 'approved' | 'rejected' | 'error' | string
  rejection_reason: string | null
  created_at: string
  // Flattened calculation results
  purity: number | null
  retention_time: number | null
  compound_id: string | null
  has_results: boolean
}

/**
 * Get all samples for a job with their calculation results flattened.
 * Used for batch review tables where you need quick access to key values.
 */
export async function getSamplesWithResults(
  jobId: number
): Promise<SampleWithResults[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/jobs/${jobId}/samples-with-results`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get job ${jobId} samples with results failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get job ${jobId} samples with results error:`, error)
    throw error
  }
}

// --- Samples API ---

/**
 * Get recent samples.
 */
export async function getSamples(limit = 50): Promise<Sample[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/samples?limit=${limit}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get samples failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get samples error:', error)
    throw error
  }
}

/**
 * Get a single sample by ID.
 */
export async function getSample(sampleId: number): Promise<Sample> {
  try {
    const response = await fetch(`${API_BASE_URL()}/samples/${sampleId}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get sample ${sampleId} failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get sample ${sampleId} error:`, error)
    throw error
  }
}

/**
 * Approve a sample.
 * Sets status to 'approved' and clears any rejection reason.
 */
export async function approveSample(sampleId: number): Promise<Sample> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/samples/${sampleId}/approve`,
      {
        method: 'PUT',
        headers: getBearerHeaders(),
      }
    )
    if (!response.ok) {
      throw new Error(`Approve sample ${sampleId} failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Approve sample ${sampleId} error:`, error)
    throw error
  }
}

/**
 * Reject a sample with a reason.
 * Sets status to 'rejected' and stores the rejection reason.
 */
export async function rejectSample(
  sampleId: number,
  reason: string
): Promise<Sample> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/samples/${sampleId}/reject`,
      {
        method: 'PUT',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify({ reason }),
      }
    )
    if (!response.ok) {
      throw new Error(`Reject sample ${sampleId} failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Reject sample ${sampleId} error:`, error)
    throw error
  }
}

// --- Calculations API ---

/**
 * Result of a single calculation.
 */
export interface CalculationResult {
  calculation_type: string
  input_summary: Record<string, unknown>
  output_values: Record<string, number | string | Record<string, unknown>>
  warnings: string[]
  success: boolean
  error: string | null
}

/**
 * Summary of calculations run on a sample.
 */
export interface CalculationSummary {
  sample_id: number
  results: CalculationResult[]
  total_calculations: number
  successful: number
  failed: number
}

/**
 * Stored result record from database.
 */
export interface StoredResult {
  id: number
  sample_id: number
  calculation_type: string
  input_data: Record<string, unknown> | null
  output_data: Record<string, unknown> | null
  created_at: string
}

/**
 * Run all applicable calculations for a sample.
 * Results are stored in the database and returned.
 */
export async function calculateSample(
  sampleId: number
): Promise<CalculationSummary> {
  try {
    const response = await fetch(`${API_BASE_URL()}/calculate/${sampleId}`, {
      method: 'POST',
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Calculate sample ${sampleId} failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Calculate sample ${sampleId} error:`, error)
    throw error
  }
}

/**
 * Get list of available calculation types.
 */
export async function getCalculationTypes(): Promise<string[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/calculations/types`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get calculation types failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get calculation types error:', error)
    throw error
  }
}

/**
 * Preview a calculation without saving.
 * Useful for testing formulas with custom data.
 */
export async function previewCalculation(
  data: Record<string, unknown>,
  calculationType: string
): Promise<CalculationResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/calculate/preview`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        data,
        calculation_type: calculationType,
      }),
    })
    if (!response.ok) {
      throw new Error(`Preview calculation failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Preview calculation error:', error)
    throw error
  }
}

/**
 * Get all stored calculation results for a sample.
 */
export async function getSampleResults(
  sampleId: number
): Promise<StoredResult[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/samples/${sampleId}/results`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get sample ${sampleId} results failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get sample ${sampleId} results error:`, error)
    throw error
  }
}

// --- File Watcher API ---

/**
 * File watcher status.
 */
export interface WatcherStatus {
  is_running: boolean
  watch_path: string | null
  pending_files: number
}

/**
 * Detected files response.
 */
export interface DetectedFiles {
  files: string[]
  count: number
}

/**
 * Get file watcher status.
 */
export async function getWatcherStatus(): Promise<WatcherStatus> {
  try {
    const response = await fetch(`${API_BASE_URL()}/watcher/status`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error('Failed to get watcher status')
    }
    return response.json()
  } catch (error) {
    console.error('Get watcher status error:', error)
    throw error
  }
}

/**
 * Start file watcher using report_directory from settings.
 */
export async function startWatcher(): Promise<{
  status: string
  watching: string
}> {
  try {
    const response = await fetch(`${API_BASE_URL()}/watcher/start`, {
      method: 'POST',
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.detail || 'Failed to start watcher')
    }
    return response.json()
  } catch (error) {
    console.error('Start watcher error:', error)
    throw error
  }
}

/**
 * Stop file watcher.
 */
export async function stopWatcher(): Promise<{ status: string }> {
  try {
    const response = await fetch(`${API_BASE_URL()}/watcher/stop`, {
      method: 'POST',
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error('Failed to stop watcher')
    }
    return response.json()
  } catch (error) {
    console.error('Stop watcher error:', error)
    throw error
  }
}

/**
 * Get and clear list of detected files.
 */
export async function getDetectedFiles(): Promise<DetectedFiles> {
  try {
    const response = await fetch(`${API_BASE_URL()}/watcher/files`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error('Failed to get detected files')
    }
    return response.json()
  } catch (error) {
    console.error('Get detected files error:', error)
    throw error
  }
}

// --- Explorer API (Integration Service Database) ---

/**
 * Get headers for explorer endpoints.
 * API key for the Integration Service is now in the backend .env,
 * so we only need the Bearer token here.
 */
function getAuthHeaders(): HeadersInit {
  return getBearerHeaders()
}

/**
 * Order from Integration Service database.
 */
export interface ExplorerOrder {
  id: string
  order_id: string
  order_number: string
  /** WC customer id; null for guest-bucket orders. Optional on the FE type so
   *  existing fixtures stay valid — the IS response always includes it. Mirrors
   *  IS ExplorerOrderResponse.customer_id (desktop.py LINK-07). */
  customer_id?: number | null
  status: string
  samples_expected: number
  samples_delivered: number
  error_message: string | null
  payload: Record<string, unknown> | null
  sample_results: Record<string, { senaite_id: string; status: string }> | null
  created_at: string
  updated_at: string
  completed_at: string | null
  wp_order_status: string | null
}

/**
 * Typed view of the WooCommerce order payload stored from the incoming webhook.
 */
export interface OrderPayloadBilling {
  company_name: string | null
  first_name: string
  last_name: string
  email: string
  phone: string | null
  address_1: string | null
  city: string | null
  state: string | null
  postcode: string | null
  country: string
}

export interface OrderPayloadSample {
  number: number
  analytical_test: string
  sample_identity: string
  sample_weight: string
  sample_name: string | null
  lot_code: string | null
  notes: string | null
  services: Record<string, boolean>
  prices: Record<string, number>
  variance_value: string | number | null
  package: string | null
}

export interface OrderPayload {
  order_id: number
  order_number: string
  billing: OrderPayloadBilling
  samples: OrderPayloadSample[]
  submitted_at: string
}

/** Cast a raw payload dict to a typed OrderPayload, or null if missing. */
export function parseOrderPayload(payload: Record<string, unknown> | null): OrderPayload | null {
  if (!payload) return null
  return payload as unknown as OrderPayload
}

/**
 * WooCommerce order from the WC REST API (/wp-json/wc/v3/orders/{id}).
 * Includes full financial breakdown unavailable in the webhook snapshot.
 */
export interface WooLineItem {
  id: number
  name: string
  product_id: number
  quantity: number
  subtotal: string
  total: string
  sku: string
  price: number
}

export interface WooCouponLine {
  id: number
  code: string
  discount: string
  discount_tax: string
}

export interface WooShippingLine {
  id: number
  method_title: string
  total: string
}

export interface WooTaxLine {
  id: number
  label: string
  tax_total: string
  shipping_tax_total: string
}

export interface WooOrder {
  id: number
  number: string
  status: string
  date_created: string
  date_paid: string | null
  currency: string
  currency_symbol: string
  discount_total: string
  discount_tax: string
  shipping_total: string
  cart_tax: string
  total: string
  total_tax: string
  billing: {
    first_name: string
    last_name: string
    company: string
    address_1: string
    city: string
    state: string
    postcode: string
    country: string
    email: string
    phone: string
  }
  payment_method_title: string
  customer_note: string
  line_items: WooLineItem[]
  shipping_lines: WooShippingLine[]
  coupon_lines: WooCouponLine[]
  tax_lines: WooTaxLine[]
}

/**
 * Fetch a WooCommerce order directly via the WC REST API proxy.
 * Returns null if the order is not found.
 */
export async function getWooOrder(orderId: string): Promise<WooOrder | null> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/woo/orders/${encodeURIComponent(orderId)}`,
      { headers: getAuthHeaders() }
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`WooCommerce order fetch failed: ${response.status}`)
    return response.json()
  } catch (error) {
    console.error('Get WooCommerce order error:', error)
    throw error
  }
}

/**
 * Ingestion from Integration Service database.
 */
export interface ExplorerIngestion {
  id: string
  sample_id: string
  coa_version: number
  order_ref: string | null
  status: string
  s3_key: string | null
  verification_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  processing_time_ms: number | null
}

/**
 * Connection status for Integration Service database.
 */
export interface ExplorerConnectionStatus {
  connected: boolean
  environment?: string
  database?: string
  host?: string
  wordpress_host?: string
  error?: string
}

/**
 * Submission attempt (retry audit trail).
 */
export interface ExplorerAttempt {
  id: string
  attempt_number: number
  event_id: string | null
  status: string
  error_message: string | null
  samples_processed: Record<string, unknown> | null
  created_at: string
}

/**
 * COA generation record.
 */
export interface ExplorerCOAGeneration {
  id: string
  sample_id: string
  generation_number: number
  verification_code: string
  content_hash: string
  status: string // draft | published | superseded
  anchor_status: string
  anchor_tx_hash: string | null
  chromatogram_s3_key: string | null
  chromatogram_5k_url: string | null
  chromatogram_10k_url: string | null
  published_at: string | null
  superseded_at: string | null
  created_at: string
  order_id: string | null
  order_number: string | null
  /** Self-referential: null for primary COA, set for additional COAs */
  parent_generation_id: string | null
  /** 1-based vial number for per-vial HPLC COA children; null for primaries and branding additional COAs */
  vial_sequence: number | null
  /** True for the regular parent-services COA child (plain COA generated alongside a variance primary) */
  is_regular_coa: boolean
  /** Ingestion WP delivery status: pending | processing | uploaded | notified | partial | failed */
  ingestion_status: string | null
}

/**
 * Sample status event (workflow transition).
 */
export interface ExplorerSampleEvent {
  id: string
  sample_id: string
  transition: string
  new_status: string
  event_id: string | null
  event_timestamp: number | null
  wp_notified: boolean
  wp_status_sent: string | null
  wp_error: string | null
  created_at: string
}

/**
 * COA access/download log entry.
 */
export interface ExplorerAccessLog {
  id: string
  sample_id: string
  coa_version: number
  action: string
  requester_ip: string | null
  user_agent: string | null
  requested_by: string | null
  timestamp: string
}

/**
 * Presigned URL response for COA/chromatogram downloads.
 */
export interface ExplorerSignedURLResponse {
  url: string
  expires_at: string
  sample_id: string
  version: number | null
}

/**
 * Check connection to Integration Service database.
 */
export async function getExplorerStatus(): Promise<ExplorerConnectionStatus> {
  try {
    const response = await fetch(`${API_BASE_URL()}/explorer/status`, {
      headers: getAuthHeaders(),
    })
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer status failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer status error:', error)
    throw error
  }
}

/**
 * Available environments response.
 */
export interface EnvironmentListResponse {
  environments: string[]
  current: string
}

/**
 * Get available database environments.
 */
export async function getExplorerEnvironments(): Promise<EnvironmentListResponse> {
  try {
    const response = await fetch(`${API_BASE_URL()}/explorer/environments`, {
      headers: getAuthHeaders(),
    })
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer environments failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer environments error:', error)
    throw error
  }
}

/**
 * Switch to a different database environment.
 *
 * @param environment - "local" or "production"
 * @returns Connection status after switching
 */
export async function setExplorerEnvironment(
  environment: string
): Promise<ExplorerConnectionStatus> {
  try {
    const response = await fetch(`${API_BASE_URL()}/explorer/environments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ environment }),
    })
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Set explorer environment failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Set explorer environment error:', error)
    throw error
  }
}

/**
 * Get orders from Integration Service database.
 *
 * @param search - Optional search term for order_id or order_number
 * @param limit - Max records to return (default 50)
 * @param offset - Pagination offset (default 0)
 * @param status - Optional status filter
 */
export async function getExplorerOrders(
  search?: string,
  limit = 50,
  offset = 0,
  status?: string
): Promise<ExplorerOrder[]> {
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (status) params.set('status', status)
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders?${params}`,
      {
        headers: getAuthHeaders(),
      }
    )
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer orders failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer orders error:', error)
    throw error
  }
}

/**
 * Get a single order from Integration Service by its WordPress order ID.
 * Returns null if not found.
 */
export async function getExplorerOrderById(orderId: string): Promise<ExplorerOrder | null> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}`,
      { headers: getAuthHeaders() }
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Get order failed: ${response.status}`)
    return response.json()
  } catch (error) {
    console.error('Get order by ID error:', error)
    throw error
  }
}

// --- Phase 29: Explorer Customers (LINK-04/05/06 consumed by UI-02..UI-07) ---

/**
 * Aggregated customer record from /explorer/customers (Phase 28 LINK-04/05/06).
 *
 * Field shape mirrors the backend Pydantic `ExplorerCustomerResponse` at
 * `integration-service/app/api/desktop.py:108-123`. Snake_case is intentional
 * (CONTEXT D-06) — no camelCase translation layer.
 *
 * `customer_id` is `null` for the guest bucket (orders with `customer_id IS NULL`,
 * grouped by billing email — Phase 28 D-12). Guest rows are non-clickable in the
 * list view (CONTEXT D-14).
 */
export interface ExplorerCustomer {
  customer_id: number | null
  email: string
  display_name: string
  company_name: string | null
  total_orders: number
  outstanding_orders: number
  total_coas: number
  most_recent_order_at: string | null
}

/**
 * Paginated response for /explorer/customers.
 *
 * `total_count` is unconditionally returned by the backend (Phase 28 D-22), but
 * the TS type keeps it optional (`?:`) per CONTEXT D-06 — forward-compat hedge
 * if the endpoint ever drops it for streaming/large-page modes.
 */
export interface ExplorerCustomersResponse {
  customers: ExplorerCustomer[]
  total_count?: number
}

/**
 * Get aggregated customers from Integration Service database.
 *
 * Mirrors the `getExplorerOrders` envelope (try/catch + 401 branch + URLSearchParams
 * + getAuthHeaders + API_BASE_URL). Server owns all filters (CONTEXT D-07);
 * no client-side re-filtering.
 *
 * @param search - Optional search term; backend matches email/first_name/last_name/company_name (Phase 28 D-15)
 * @param page - 0-indexed page (converted to backend offset via page * perPage)
 * @param perPage - Page size (default 50)
 * @param includeTestEmails - When false (default), backend excludes TEST_EMAILS list (Phase 28 D-17)
 */
export async function getExplorerCustomers(
  search?: string,
  page = 0,
  perPage = 50,
  includeTestEmails = false
): Promise<ExplorerCustomersResponse> {
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    params.set('limit', String(perPage))
    params.set('offset', String(page * perPage))
    params.set('include_test_emails', String(includeTestEmails))

    const response = await fetch(
      `${API_BASE_URL()}/explorer/customers?${params}`,
      {
        headers: getAuthHeaders(),
      }
    )
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer customers failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer customers error:', error)
    throw error
  }
}

/**
 * Get a single customer (+ aggregate stats) by WC customer ID.
 *
 * Authoritative read from wc_customers via IS `/explorer/customers/{id}`. Used by
 * the customer-detail header on cold load (deep-link / refresh) when the
 * customers-list cache is empty. Returns null on 404 (unknown / soft-deleted).
 */
export async function getExplorerCustomerById(
  customerId: number
): Promise<ExplorerCustomer | null> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/customers/${customerId}`,
      { headers: getAuthHeaders() }
    )
    if (response.status === 404) return null
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer customer failed: ${response.status}`)
    }
    return (await response.json()) as ExplorerCustomer
  } catch (error) {
    console.error('getExplorerCustomerById error:', error)
    throw error
  }
}

/**
 * Get orders filtered by a specific WooCommerce customer ID.
 *
 * Thin wrapper over `/explorer/orders?customer_id=X` (Phase 28 LINK-07).
 * Implemented inline rather than delegating to `getExplorerOrders` to keep the
 * URL shape explicit and avoid coupling the customer-detail path to the
 * generic-orders signature.
 *
 * @param customerId - WC customer ID (guest aggregation is not supported here; see DEFERRED-01)
 * @param limit - Max records to return (default 200 — covers heavy-customer accounts in one round-trip)
 * @param offset - Pagination offset (default 0)
 */
export async function getExplorerOrdersByCustomer(
  customerId: number,
  // UX revision (post-Phase 30): three independent search axes, AND-combined
  // server-side. Each axis is independently optional, and each is gated on a
  // 2-char minimum HERE in the client (the backend treats '' as "no filter on
  // that axis" but doesn't enforce a minimum length — the gate is purely a UX
  // anti-flicker convention).
  search?: {
    order_number?: string
    sample_id?: string
    analyte?: string
  },
  sort: 'open_first' | 'date_desc' | 'date_asc' = 'open_first',
  page = 0,
  perPage = 50
): Promise<ExplorerOrder[]> {
  try {
    const params = new URLSearchParams()
    params.set('customer_id', String(customerId))
    params.set('limit', String(perPage))
    params.set('offset', String(page * perPage))
    params.set('sort', sort)
    // Per-axis 2-char minimum gate — prevents "no results" flicker as the user
    // types in each input independently. A fully-typed sample_id is forwarded
    // even if analyte is still 1 char (each axis gates itself).
    if (search) {
      if (search.order_number && search.order_number.length >= 2) {
        params.set('search_order_number', search.order_number)
      }
      if (search.sample_id && search.sample_id.length >= 2) {
        params.set('search_sample_id', search.sample_id)
      }
      if (search.analyte && search.analyte.length >= 2) {
        params.set('search_analyte', search.analyte)
      }
    }

    const res = await fetch(
      `${API_BASE_URL()}/explorer/orders?${params.toString()}`,
      { headers: getAuthHeaders() }
    )
    if (res.status === 401) {
      throw new Error('API key required or invalid')
    }
    if (!res.ok) {
      throw new Error(`Get explorer orders by customer failed: ${res.status}`)
    }
    return (await res.json()) as ExplorerOrder[]
  } catch (error) {
    console.error('getExplorerOrdersByCustomer error:', error)
    throw error
  }
}

/**
 * Get all COA generations across all orders from Integration Service.
 *
 * @param search - Optional search term for sample_id
 * @param limit - Max records to return (default 50)
 * @param offset - Pagination offset (default 0)
 * @param status - Optional status filter (draft, published, superseded)
 * @param anchorStatus - Optional anchor_status filter (pending, confirming, anchored, failed)
 */
export async function getExplorerCOAGenerations(
  search?: string,
  limit = 50,
  offset = 0,
  status?: string,
  anchorStatus?: string
): Promise<ExplorerCOAGeneration[]> {
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (status) params.set('status', status)
    if (anchorStatus) params.set('anchor_status', anchorStatus)
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    const response = await fetch(
      `${API_BASE_URL()}/explorer/coa-generations?${params}`,
      {
        headers: getAuthHeaders(),
      }
    )
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(`Get explorer COA generations failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer COA generations error:', error)
    throw error
  }
}

/**
 * Get all ingestions for an order from Integration Service database.
 *
 * @param orderId - The WordPress order ID (e.g., "12345")
 */
export async function getOrderIngestions(
  orderId: string
): Promise<ExplorerIngestion[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}/ingestions`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('API key required or invalid')
      }
      throw new Error(
        `Get order ${orderId} ingestions failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} ingestions error:`, error)
    throw error
  }
}

/**
 * Get submission attempts for an order (retry audit trail).
 */
export async function getOrderAttempts(
  orderId: string
): Promise<ExplorerAttempt[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}/attempts`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get order ${orderId} attempts failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} attempts error:`, error)
    throw error
  }
}

/**
 * Get COA generations for an order.
 */
export async function getOrderCOAGenerations(
  orderId: string
): Promise<ExplorerCOAGeneration[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}/coa-generations`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get order ${orderId} COA generations failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} COA generations error:`, error)
    throw error
  }
}

/**
 * Get sample status events for an order (workflow transitions).
 */
export async function getOrderSampleEvents(
  orderId: string
): Promise<ExplorerSampleEvent[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}/sample-events`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get order ${orderId} sample events failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} sample events error:`, error)
    throw error
  }
}

/**
 * Get all sample status events across all orders (most recent first).
 */
export async function getAllSampleEvents(
  limit = 200
): Promise<ExplorerSampleEvent[]> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/sample-events?limit=${limit}`,
    { headers: getAuthHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Get sample events failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Get COA access logs for an order.
 */
export async function getOrderAccessLogs(
  orderId: string
): Promise<ExplorerAccessLog[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/orders/${encodeURIComponent(orderId)}/access-logs`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get order ${orderId} access logs failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} access logs error:`, error)
    throw error
  }
}

/**
 * Get a presigned download URL for a COA PDF.
 */
export async function getExplorerCOASignedUrl(
  sampleId: string,
  version: number
): Promise<ExplorerSignedURLResponse> {
  try {
    const response = await fetch(`${API_BASE_URL()}/explorer/signed-url/coa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ sample_id: sampleId, version }),
    })
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`COA PDF not found for ${sampleId} v${version}`)
      }
      throw new Error(`Get COA signed URL failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get COA signed URL error:`, error)
    throw error
  }
}

/**
 * Get a presigned download URL for a chromatogram image.
 */
export async function getExplorerChromatogramSignedUrl(
  sampleId: string,
  version: number
): Promise<ExplorerSignedURLResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/signed-url/chromatogram`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ sample_id: sampleId, version }),
      }
    )
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Chromatogram not found for ${sampleId}`)
      }
      throw new Error(`Get chromatogram signed URL failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get chromatogram signed URL error:`, error)
    throw error
  }
}

// --- Additional COA Configs ---

export interface AdditionalCOAConfig {
  config_id: string
  coa_index: number
  status: string
  wp_profile_id: string | null
  coa_info: {
    company_name?: string
    website?: string
    email?: string
    address?: string
    logo_url?: string
    chromatograph_background_url?: string
  }
  generation_id: string | null
  verification_code: string | null
  generation_number: number | null
}

// --- Analysis Management ---

export interface AnalysisService {
  uid: string
  title: string
  keyword: string
  result_type?: string | null
  result_options?: { value: string; label: string }[] | null
}

export interface ManageAnalysisResult {
  success: boolean
  message: string
}

export async function listAnalysisServices(): Promise<AnalysisService[]> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/analysis-services`,
    { headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error(`Failed to list analysis services: ${response.status}`)
  return response.json()
}

export async function addAnalysisToSample(
  sampleId: string,
  serviceUid: string,
): Promise<ManageAnalysisResult> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/samples/${encodeURIComponent(sampleId)}/analyses`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ service_uid: serviceUid }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Failed to add analysis: ${response.status}`)
  }
  return response.json()
}

/** One vial row in a removal-impact bucket. */
export interface RemovalImpactRow {
  analysis_id: number
  sample_id: string
  keyword: string
  review_state: string
}

/** Vial-tier rows a parent-service removal would touch, by tier.
 *  pristine -> deleted silently · worked_unverified -> retracted on confirm ·
 *  blocked -> verified/published, removal refused until invalidated. */
export interface RemovalImpact {
  pristine: RemovalImpactRow[]
  worked_unverified: RemovalImpactRow[]
  blocked: RemovalImpactRow[]
}

export async function getRemovalImpact(
  sampleId: string,
  keyword: string,
): Promise<RemovalImpact> {
  return apiFetch<RemovalImpact>(
    `/explorer/samples/${encodeURIComponent(sampleId)}/analyses/${encodeURIComponent(keyword)}/removal-impact`,
  )
}

/** Peptide ids eligible for Replace (have a full ID_/PUR_/QTY_ service set). */
export async function getPeptidesWithServiceSet(): Promise<number[]> {
  const r = await apiFetch<{ peptide_ids: number[] }>('/peptides/with-service-set')
  return r.peptide_ids
}

export interface ReplaceAnalyteResult {
  success: boolean
  field_updated: string
  new_peptide: string
  identity: { removed: string | null; added: string | null }
  slot: number
  old_peptide_id: number
  new_peptide_id: number
  vials: { deleted: unknown[]; retracted: unknown[]; blocked: unknown[]; reseeded: string[] }
}

/** Replace the peptide on one analyte slot. Throws on non-2xx; the thrown
 *  error carries `.status` and `.impact` (for the 412 retract-confirm flow)
 *  and `.detail` (409 blocked / 400 offer-only message). */
export async function replaceAnalyte(
  sampleId: string,
  slot: number,
  body: { newPeptideId: number; oldPeptideId: number; senaiteUid: string; force?: boolean },
): Promise<ReplaceAnalyteResult> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/samples/${encodeURIComponent(sampleId)}/analytes/${slot}/replace`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        new_peptide_id: body.newPeptideId,
        old_peptide_id: body.oldPeptideId,
        senaite_uid: body.senaiteUid,
        force: body.force ?? false,
      }),
    },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const err = new Error(
      typeof payload?.detail === 'string' ? payload.detail : `Replace failed: ${response.status}`,
    ) as Error & { status?: number; impact?: RemovalImpact; detail?: unknown }
    err.status = response.status
    err.detail = payload?.detail
    // 412 carries the impact buckets so the FE can show the retract-confirm modal.
    if (response.status === 412 && payload?.detail && typeof payload.detail === 'object') {
      err.impact = payload.detail as RemovalImpact
    }
    throw err
  }
  return response.json()
}

export async function removeAnalysisFromSample(
  sampleId: string,
  keyword: string,
  opts?: { confirmRetract?: boolean },
): Promise<ManageAnalysisResult> {
  const qs = opts?.confirmRetract ? '?confirm_retract=true' : ''
  const response = await fetch(
    `${API_BASE_URL()}/explorer/samples/${encodeURIComponent(sampleId)}/analyses/${encodeURIComponent(keyword)}${qs}`,
    {
      method: 'DELETE',
      headers: getAuthHeaders(),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Failed to remove analysis: ${response.status}`)
  }
  return response.json()
}

/**
 * Get additional COA configurations for a sample.
 */
export async function getSampleAdditionalCOAs(
  sampleId: string
): Promise<AdditionalCOAConfig[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/explorer/samples/${encodeURIComponent(sampleId)}/additional-coas`,
      { headers: getAuthHeaders() }
    )
    if (!response.ok) {
      if (response.status === 503) return []
      throw new Error(`Get additional COAs failed: ${response.status}`)
    }
    return response.json()
  } catch {
    return []
  }
}

/**
 * Fetch LTTB-compressed chromatogram JSON via backend proxy.
 */
export async function fetchChromatogramLttb(
  verificationCode: string,
  resolution: '5k' | '10k',
): Promise<{ x: number[]; y: number[]; peaks?: any[]; points?: number; source_points?: number }> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/chromatogram-lttb/${encodeURIComponent(verificationCode)}/${resolution}`,
    { headers: getAuthHeaders() },
  )
  if (!response.ok) throw new Error(`LTTB fetch failed: ${response.status}`)
  return response.json()
}

export interface AdditionalCOAUpdateResponse {
  success: boolean
  message: string
  updated_fields: string[]
}

export async function updateAdditionalCOAConfig(
  configId: string,
  fields: Partial<AdditionalCOAConfig['coa_info']>
): Promise<AdditionalCOAUpdateResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/explorer/additional-coas/${encodeURIComponent(configId)}`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(fields),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Update failed: ${response.status}`)
  }
  return response.json()
}

// --- COA Actions ---

export interface SampleCOAActionResponse {
  success: boolean
  message: string
  verification_code: string | null
  warning?: string | null
}

async function extractErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json()
    const detail = body?.detail ?? body?.message ?? fallback
    if (typeof detail === 'string') return detail
    // Structured detail (e.g. the COA resolver's unresolved_sources 422):
    // render the message + offending analytes instead of [object Object].
    if (detail && typeof detail === 'object') {
      // The COA resolver's unresolved_sources 422 already formats a
      // newline-bulleted message (name + plain-English reason per analyte).
      // Honor it verbatim; only synthesize a fallback list for older shapes
      // that lack the pre-formatted message.
      if (typeof detail.message === 'string' && detail.message.includes('\n')) {
        return detail.message
      }
      let msg: string = detail.message ?? fallback
      if (Array.isArray(detail.unresolved) && detail.unresolved.length > 0) {
        const lines = detail.unresolved
          .map((u: { analyte_name?: string; analyte_keyword?: string; reason?: string }) => {
            const name = u.analyte_name ?? u.analyte_keyword
            if (!name) return null
            return u.reason ? `- ${name}: ${u.reason}` : `- ${name}`
          })
          .filter(Boolean)
          .join('\n')
        if (lines) msg += `\n${lines}`
      }
      return msg
    }
    return fallback
  } catch {
    return fallback
  }
}

export async function generateSenaiteCOA(
  sampleId: string
): Promise<SampleCOAActionResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/generate-coa`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `COA generation failed: ${response.status}`))
  return response.json()
}

export interface GenerateVialCOAsResult {
  success: boolean
  message: string
  expected: number
  generated: { vial_sequence: number; verification_code: string | null; generation_id: string | null }[]
  skipped: number[]
  errors: { vial_sequence: number; error: string }[]
}

/**
 * Generate one per-vial HPLC COA for each reportable HPLC vial of a parent.
 * The parent COA generation is derived server-side (not passed by the client).
 * Idempotent: vials that already have a COA are skipped.
 */
export async function generateVialCOAs(
  sampleId: string
): Promise<GenerateVialCOAsResult> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/generate-vial-coas`,
    {
      method: 'POST',
      headers: { ...getBearerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `Vial COA generation failed: ${response.status}`))
  return response.json()
}

export async function publishSenaiteCOA(
  sampleId: string
): Promise<SampleCOAActionResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/publish-coa`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `COA publish failed: ${response.status}`))
  return response.json()
}

export async function regenPrimaryCOA(
  sampleId: string
): Promise<SampleCOAActionResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/regen-primary-coa`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `Primary COA regen failed: ${response.status}`))
  return response.json()
}

export async function regenAdditionalCOA(
  configId: string
): Promise<SampleCOAActionResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/additional-coas/${encodeURIComponent(configId)}/regen-coa`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(await extractErrorMessage(response, `Additional COA regen failed: ${response.status}`))
  return response.json()
}

// --- HPLC Analysis API ---

export interface HPLCPeak {
  height: number
  area: number
  area_percent: number
  begin_time: number
  end_time: number
  retention_time: number
  is_solvent_front: boolean
  is_main_peak: boolean
}

export interface HPLCInjection {
  injection_name: string
  peptide_label: string
  peaks: HPLCPeak[]
  total_area: number
  main_peak_index: number
}

export interface HPLCPurity {
  purity_percent: number | null
  individual_values: number[]
  injection_names: string[]
  rsd_percent: number | null
  error?: string
}

export interface StandardInjection {
  analyte_label: string
  main_peak_rt: number
  main_peak_area_pct: number
  source_sample_id: string
  filename: string
}

export interface HPLCParseResult {
  injections: HPLCInjection[]
  purity: HPLCPurity
  errors: string[]
  warnings: string[]
  detected_peptides: string[]
  standard_injections: StandardInjection[]
}

export async function parseHPLCFiles(
  files: { filename: string; content: string }[]
): Promise<HPLCParseResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/hplc/parse-files`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ files }),
    })
    if (!response.ok) {
      throw new Error(`Parse HPLC files failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Parse HPLC files error:', error)
    throw error
  }
}

// --- Peptide & Calibration API ---

export interface CalibrationCurve {
  id: number
  peptide_id: number
  peptide_analyte_id: number | null
  reference_rt: number | null
  rt_tolerance: number
  diluent_density: number
  slope: number
  intercept: number
  r_squared: number
  standard_data: { concentrations: number[]; areas: number[]; rts?: number[]; excluded_indices?: number[] } | null
  source_filename: string | null
  source_path: string | null
  source_date: string | null
  sharepoint_url: string | null
  is_active: boolean
  created_at: string
  // Standard identification metadata
  source_sample_id: string | null
  instrument: string | null
  instrument_id: number | null
  vendor: string | null
  lot_number: string | null
  batch_number: string | null
  cap_color: string | null
  run_date: string | null
  // Wizard fields
  standard_weight_mg: number | null
  stock_concentration_ug_ml: number | null
  diluent: string | null
  column_type: string | null
  wavelength_nm: number | null
  flow_rate_ml_min: number | null
  injection_volume_ul: number | null
  operator: string | null
  notes: string | null
  // Phase 09: Chromatogram storage
  chromatogram_data: { times: number[]; signals: number[] } | null
  source_sharepoint_folder: string | null
  // User tracking
  created_by_user_id: number | null
  created_by_email: string | null
  updated_by_user_id: number | null
  updated_by_email: string | null
}

export interface InstrumentSummary {
  instrument: string // "1260", "1290", or "unknown"
  instrument_id: number | null
  curve_count: number
}

// ─── Instrument types ───

export interface Instrument {
  id: number
  name: string
  senaite_id: string | null
  senaite_uid: string | null
  instrument_type: string | null
  brand: string | null
  model: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface InstrumentBrief {
  id: number
  name: string
  model: string | null
}

// ─── HPLC Method types ───

export interface PeptideBrief {
  id: number
  name: string
  abbreviation: string
}

export interface MethodBrief {
  id: number
  name: string
  senaite_id: string | null
  instrument_ids: number[]
  instruments: InstrumentBrief[]
}

export interface HplcMethod {
  id: number
  name: string
  senaite_id: string | null
  instrument_ids: number[]
  instruments: InstrumentBrief[]
  size_peptide: string | null
  starting_organic_pct: number | null
  temperature_mct_c: number | null
  dissolution: string | null
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
  common_peptides: PeptideBrief[]
}

export interface HplcMethodInput {
  name: string
  senaite_id?: string | null
  instrument_ids?: number[]
  size_peptide?: string | null
  starting_organic_pct?: number | null
  temperature_mct_c?: number | null
  dissolution?: string | null
  notes?: string | null
}

// ─── Peptide types ───

export interface AnalyteInput {
  slot: number
  analysis_service_id: number
  sample_id?: string | null
  component_peptide_id?: number | null
}

export interface AnalyteResponse {
  id: number
  slot: number
  analysis_service_id: number
  sample_id: string | null
  peptide_name: string | null
  service_title: string | null
  component_peptide_id: number | null
  component_abbreviation: string | null
}

export interface ComponentBrief {
  id: number
  name: string
  abbreviation: string
  vial_number?: number
  hplc_aliases?: string[] | null
}

export type AnalyteClass = 'peptide' | 'additive'

export interface PeptideRecord {
  id: number
  name: string
  abbreviation: string
  active: boolean
  is_blend: boolean
  analyte_class: AnalyteClass
  prep_vial_count: number
  hplc_aliases?: string[] | null
  display_aliases?: string[] | null
  created_at: string
  updated_at: string
  methods: MethodBrief[]
  active_calibration: CalibrationCurve | null
  calibration_summary: InstrumentSummary[]
  analytes: AnalyteResponse[]
  components: ComponentBrief[]
}

export interface PeptideCreateInput {
  name: string
  abbreviation: string
  analytes?: AnalyteInput[]
  is_blend?: boolean
  component_ids?: number[]
  analyte_class?: AnalyteClass
}

export type BlendCalibrationData = Record<string, {
  peptide_id: number
  name: string
  calibrations: CalibrationCurve[]
}>

export interface CalibrationDataInput {
  concentrations: number[]
  areas: number[]
  rts?: number[]
  source_filename?: string
  analyte_id?: number
  instrument?: string
  notes?: string
}

export async function getPeptides(opts?: { analyteClass?: AnalyteClass }): Promise<PeptideRecord[]> {
  try {
    const qs = opts?.analyteClass ? `?analyte_class=${encodeURIComponent(opts.analyteClass)}` : ''
    const response = await fetch(`${API_BASE_URL()}/peptides${qs}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get peptides failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get peptides error:', error)
    throw error
  }
}

export async function createPeptide(
  data: PeptideCreateInput
): Promise<PeptideRecord> {
  try {
    const response = await fetch(`${API_BASE_URL()}/peptides`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(
        err?.detail || `Create peptide failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error('Create peptide error:', error)
    throw error
  }
}

export async function updatePeptide(
  peptideId: number,
  data: Partial<PeptideCreateInput & {
    active: boolean
    method_ids: number[]
    prep_vial_count: number
    hplc_aliases: string[] | null
    display_aliases: string[] | null
    component_vial_assignments: Record<string, number>
  }>
): Promise<PeptideRecord> {
  try {
    const response = await fetch(`${API_BASE_URL()}/peptides/${peptideId}`, {
      method: 'PUT',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      throw new Error(`Update peptide failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Update peptide error:', error)
    throw error
  }
}

export async function deletePeptide(peptideId: number): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL()}/peptides/${peptideId}`, {
      method: 'DELETE',
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Delete peptide failed: ${response.status}`)
    }
  } catch (error) {
    console.error('Delete peptide error:', error)
    throw error
  }
}

// ─── Per-sample analyte display alias ───

export interface SampleAnalyteAliasRecord {
  slot: number
  alias: string
  updated_at: string
  updated_by_email?: string | null
}

export async function getSampleAnalyteAliases(
  sampleId: string
): Promise<SampleAnalyteAliasRecord[]> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/analyte-aliases`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Get sample analyte aliases failed: ${response.status}`)
  }
  return response.json()
}

export async function setSampleAnalyteAlias(
  sampleId: string,
  slot: number,
  alias: string
): Promise<SampleAnalyteAliasRecord> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/analyte-aliases/${slot}`,
    {
      method: 'PUT',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ alias }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Set analyte alias failed: ${response.status}`)
  }
  return response.json()
}

export async function clearSampleAnalyteAlias(
  sampleId: string,
  slot: number
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleId)}/analyte-aliases/${slot}`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok && response.status !== 204) {
    throw new Error(`Clear analyte alias failed: ${response.status}`)
  }
}

// ─── Instrument CRUD ───

export async function getInstruments(): Promise<Instrument[]> {
  const response = await fetch(`${API_BASE_URL()}/instruments`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Get instruments failed: ${response.status}`)
  return response.json()
}

export async function syncInstruments(): Promise<{ created: number; total: number }> {
  const response = await fetch(`${API_BASE_URL()}/instruments/sync`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Sync instruments failed: ${response.status}`)
  }
  return response.json()
}

// ─── Analysis Services ───

export interface AnalysisServiceRecord {
  id: number
  title: string
  keyword: string | null
  category: string | null
  unit: string | null
  methods: { uid: string; title: string }[] | null
  peptide_name: string | null
  peptide_id: number | null
  senaite_id: string | null
  senaite_uid: string | null
  active: boolean
  result_type?: string | null
  result_options?: { value: string; label: string }[] | null
  variance_capable?: boolean
  created_at: string
  updated_at: string
}

/**
 * Fetch the local AccuMark `analysis_services` table (id + keyword + metadata).
 *
 * NOTE: This is the LOCAL endpoint at backend/main.py:2401, NOT
 * `/explorer/analysis-services` (backend/main.py:7605), which proxies to the
 * Integration Service for SENAITE data. Consumers needing keyword → service-id
 * mapping (e.g., the order-SLA cell in D2) must use this local one.
 */
export async function getAnalysisServices(opts?: { search?: string; category?: string }): Promise<AnalysisServiceRecord[]> {
  const searchParams = new URLSearchParams()
  if (opts?.search) searchParams.set('search', opts.search)
  if (opts?.category) searchParams.set('category', opts.category)
  const qs = searchParams.toString()
  const response = await fetch(`${API_BASE_URL()}/analysis-services${qs ? `?${qs}` : ''}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Get analysis services failed: ${response.status}`)
  return response.json()
}

export async function updateAnalysisServicePeptide(
  serviceId: number,
  peptideId: number | null
): Promise<AnalysisServiceRecord> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/${serviceId}/peptide`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ peptide_id: peptideId }),
  })
  if (!response.ok) throw new Error(`Update peptide link failed: ${response.status}`)
  return response.json()
}

export async function updateAnalysisServiceResultType(
  serviceId: number,
  body: {
    result_type: string | null
    result_options: { value: string; label: string }[] | null
  },
): Promise<AnalysisServiceRecord> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/${serviceId}/result-type`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Update result type failed: ${response.status}`)
  return response.json()
}

export async function updateAnalysisServiceVarianceCapable(
  serviceId: number,
  varianceCapable: boolean,
): Promise<AnalysisServiceRecord> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/${serviceId}/variance-capable`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ variance_capable: varianceCapable }),
  })
  if (!response.ok) throw new Error(`Update variance-capable failed: ${response.status}`)
  return response.json()
}

export async function syncAnalysisServices(): Promise<{ created: number; total: number }> {
  const response = await fetch(`${API_BASE_URL()}/analysis-services/sync`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Sync analysis services failed: ${response.status}`)
  }
  return response.json()
}

// ─── HPLC Method CRUD ───

export async function getMethods(): Promise<HplcMethod[]> {
  const response = await fetch(`${API_BASE_URL()}/hplc/methods`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Get methods failed: ${response.status}`)
  return response.json()
}

export async function createMethod(
  data: HplcMethodInput
): Promise<HplcMethod> {
  const response = await fetch(`${API_BASE_URL()}/hplc/methods`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Create method failed: ${response.status}`)
  }
  return response.json()
}

export async function updateMethod(
  methodId: number,
  data: Partial<HplcMethodInput & { active: boolean }>
): Promise<HplcMethod> {
  const response = await fetch(`${API_BASE_URL()}/hplc/methods/${methodId}`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Update method failed: ${response.status}`)
  return response.json()
}

export async function deleteMethod(methodId: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/hplc/methods/${methodId}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Delete method failed: ${response.status}`)
}

// ─── Calibration CRUD ───

export async function getCalibrations(
  peptideId: number
): Promise<CalibrationCurve[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/peptides/${peptideId}/calibrations`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(`Get calibrations failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get calibrations error:', error)
    throw error
  }
}

export async function getBlendCalibrations(
  peptideId: number
): Promise<BlendCalibrationData> {
  const response = await fetch(
    `${API_BASE_URL()}/peptides/${peptideId}/blend-calibrations`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Get blend calibrations failed: ${response.status}`)
  }
  return response.json()
}

export async function createCalibration(
  peptideId: number,
  data: CalibrationDataInput
): Promise<CalibrationCurve> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/peptides/${peptideId}/calibrations`,
      {
        method: 'POST',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify(data),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(
        err?.detail || `Create calibration failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error('Create calibration error:', error)
    throw error
  }
}

export interface StandardCalibrationInput {
  sample_prep_id: string
  concentrations: number[]
  areas: number[]
  rts?: number[]
  chromatogram_data?: { times: number[]; signals: number[] }
  source_sharepoint_folder?: string
  vendor?: string
  notes?: string
  instrument?: string
}

export async function createCalibrationFromStandard(
  peptideId: number,
  data: StandardCalibrationInput
): Promise<CalibrationCurve> {
  const response = await fetch(
    `${API_BASE_URL()}/peptides/${peptideId}/calibrations/from-standard`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      err?.detail || `Create calibration from standard failed: ${response.status}`
    )
  }
  return response.json()
}

export interface CalibrationCurveUpdateInput {
  reference_rt?: number | null
  rt_tolerance?: number
  diluent_density?: number
  instrument?: string | null
  instrument_id?: number | null
  peptide_analyte_id?: number | null
  notes?: string | null
  source_sample_id?: string | null
  vendor?: string | null
  standard_data?: {
    concentrations: number[]
    areas: number[]
    rts?: number[]
    excluded_indices?: number[]
  } | null
}

export async function updateCalibration(
  peptideId: number,
  calibrationId: number,
  data: CalibrationCurveUpdateInput
): Promise<CalibrationCurve> {
  const response = await fetch(
    `${API_BASE_URL()}/peptides/${peptideId}/calibrations/${calibrationId}`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Update calibration failed: ${response.status}`)
  }
  return response.json()
}

/** Fetch a single calibration curve with full data (including chromatogram_data). */
export async function getCalibration(
  peptideId: number,
  calibrationId: number,
): Promise<CalibrationCurve> {
  const response = await fetch(
    `${API_BASE_URL()}/peptides/${peptideId}/calibrations/${calibrationId}`,
    {
      method: 'GET',
      headers: getBearerHeaders(),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Fetch calibration failed: ${response.status}`)
  }
  return response.json()
}

export async function deleteCalibration(
  peptideId: number,
  calibrationId: number
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/peptides/${peptideId}/calibrations/${calibrationId}`,
    {
      method: 'DELETE',
      headers: getBearerHeaders(),
    }
  )
  if (!response.ok && response.status !== 204) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Delete calibration failed: ${response.status}`)
  }
}

// --- Full HPLC Analysis API ---

export interface HPLCWeightsInput {
  stock_vial_empty: number
  stock_vial_with_diluent: number
  dil_vial_empty: number
  dil_vial_with_diluent: number
  dil_vial_with_diluent_and_sample: number
}

export interface HPLCAnalyzeRequest {
  sample_id_label: string
  peptide_id: number
  calibration_curve_id?: number
  weights: HPLCWeightsInput
  injections: Record<string, unknown>[]
  // Phase 10.5: provenance fields
  sample_prep_id?: number
  instrument_id?: number
  source_sharepoint_folder?: string
  chromatogram_data?: { times: number[]; signals: number[] }
  run_group_id?: string
  // Phase 13: standard injection RT lookup for same-method identity check
  standard_injection_rts?: Record<string, { rt: number; source_sample_id: string }>
  // Phase 13.5: Audit trail
  debug_log?: { level: string; msg: string }[]
  source_files?: { filename: string; content: string; sha256: string }[]
}

export interface HPLCAnalysisResult {
  id: number
  sample_id_label: string
  peptide_id: number
  peptide_abbreviation: string
  purity_percent: number | null
  quantity_mg: number | null
  identity_conforms: boolean | null
  identity_rt_delta: number | null
  dilution_factor: number | null
  stock_volume_ml: number | null
  avg_main_peak_area: number | null
  concentration_ug_ml: number | null
  calculation_trace: Record<string, unknown> | null
  // Phase 10.5: provenance fields
  calibration_curve_id: number | null
  sample_prep_id: number | null
  instrument_id: number | null
  source_sharepoint_folder: string | null
  chromatogram_data: { times: number[]; signals: number[] } | null
  run_group_id: string | null
  raw_data: Record<string, unknown> | null
  created_at: string
  // Phase 13: identity reference source
  identity_reference_source: string | null
  identity_reference_source_id: string | null
  // Phase 13.5: Audit trail
  debug_log: { level: string; msg: string }[] | null
}

export async function runHPLCAnalysis(
  data: HPLCAnalyzeRequest
): Promise<HPLCAnalysisResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/hplc/analyze`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.detail || `HPLC analysis failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('HPLC analysis error:', error)
    throw error
  }
}

/**
 * Compute SHA256 hex digest of a string using Web Crypto API.
 */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Get all HPLC analyses for a sample prep, most recent first.
 */
export async function getHPLCAnalysesBySamplePrep(
  samplePrepId: number
): Promise<HPLCAnalysisResult[]> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/analyses/by-sample-prep/${samplePrepId}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Failed to fetch analyses: ${response.status}`)
  }
  return response.json()
}

// --- HPLC Weight Extraction API ---

export interface DilutionRow {
  label: string
  concentration: string | null
  dil_vial_empty: number
  dil_vial_with_diluent: number
  dil_vial_with_diluent_and_sample: number
}

export interface TechCalibrationData {
  concentrations: number[]
  areas: number[]
  slope: number
  intercept: number
  r_squared: number
  n_points: number
  matching_curve_ids: number[]
}

export interface AnalyteWeights {
  sheet_name: string
  stock_vial_empty: number | null
  stock_vial_with_diluent: number | null
  dilution_rows: DilutionRow[]
}

export interface WeightExtractionResult {
  found: boolean
  folder_name: string | null
  peptide_folder: string | null
  excel_filename: string | null
  stock_vial_empty: number | null
  stock_vial_with_diluent: number | null
  dilution_rows: DilutionRow[]
  error: string | null
  tech_calibration: TechCalibrationData | null
  analytes: AnalyteWeights[]
}

export async function fetchSampleWeights(
  sampleId: string
): Promise<WeightExtractionResult> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/weights/${encodeURIComponent(sampleId)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Fetch weights failed: ${response.status}`)
  }
  return response.json()
}

// --- Peptide Seed API ---

export interface SeedPeptidesResult {
  success: boolean
  output: string
  errors: string
}

export async function seedPeptides(): Promise<SeedPeptidesResult> {
  try {
    const response = await fetch(`${API_BASE_URL()}/hplc/seed-peptides`, {
      method: 'POST',
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Seed peptides failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Seed peptides error:', error)
    throw error
  }
}

// --- Seed Peptides from Analysis Services ---

export interface SeedFromServicesResult {
  created: number
  skipped: number
  total_services: number
  message: string
}

export async function seedPeptidesFromServices(): Promise<SeedFromServicesResult> {
  const response = await fetch(`${API_BASE_URL()}/peptides/seed-from-services`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Seed failed: ${response.status}`)
  }
  return response.json()
}

// --- HPLC Analysis History API ---

export interface HPLCAnalysisListItem {
  id: number
  sample_id_label: string
  peptide_abbreviation: string
  purity_percent: number | null
  quantity_mg: number | null
  identity_conforms: boolean | null
  created_at: string
}

export interface HPLCAnalysisListResponse {
  items: HPLCAnalysisListItem[]
  total: number
}

export async function getHPLCAnalyses(
  search?: string,
  peptideId?: number,
  limit = 50,
  offset = 0
): Promise<HPLCAnalysisListResponse> {
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (peptideId != null) params.set('peptide_id', String(peptideId))
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    const response = await fetch(`${API_BASE_URL()}/hplc/analyses?${params}`, {
      headers: getBearerHeaders(),
    })
    if (!response.ok) {
      throw new Error(`Get HPLC analyses failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get HPLC analyses error:', error)
    throw error
  }
}

export async function deleteHPLCAnalysis(analysisId: number): Promise<void> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/hplc/analyses/${analysisId}`,
      { method: 'DELETE', headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Delete HPLC analysis ${analysisId} failed: ${response.status}`
      )
    }
  } catch (error) {
    console.error(`Delete HPLC analysis ${analysisId} error:`, error)
    throw error
  }
}

export async function getHPLCAnalysis(
  analysisId: number
): Promise<HPLCAnalysisResult> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/hplc/analyses/${analysisId}`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get HPLC analysis ${analysisId} failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get HPLC analysis ${analysisId} error:`, error)
    throw error
  }
}

// --- Wizard Session API ---

export interface WizardMeasurementResponse {
  id: number
  session_id: number
  step_key: string
  weight_mg: number
  source: string
  vial_number: number
  is_current: boolean
  recorded_at: string
}

export interface AnalyteParams {
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
}

export interface VialParams {
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  analyte_params?: Record<string, AnalyteParams>
}

export interface WizardSessionResponse {
  id: number
  peptide_id: number
  calibration_curve_id: number | null
  status: string
  sample_id_label: string | null
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  peak_area: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
  measurements: WizardMeasurementResponse[]
  calculations: (Record<string, number> & { analyte_calculations?: Record<string, Record<string, number>> }) | null
  vial_params: Record<string, VialParams> | null
  vial_calculations: Record<string, Record<string, number> & { analyte_calculations?: Record<string, Record<string, number>> }> | null
  // Phase 09: Standard prep metadata
  is_standard: boolean
  manufacturer: string | null
  standard_notes: string | null
  instrument_name: string | null
  instrument_id: number | null
  lims_sub_sample_pk?: number | null
}

export interface WizardSessionListItem {
  id: number
  peptide_id: number
  status: string
  sample_id_label: string | null
  declared_weight_mg: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/**
 * Create a new wizard session.
 */
export async function createWizardSession(data: {
  peptide_id: number
  sample_id_label?: string
  declared_weight_mg?: number
  target_conc_ug_ml?: number
  target_total_vol_ul?: number
  vial_params?: Record<string, VialParams>
  is_standard?: boolean
  manufacturer?: string
  standard_notes?: string
  instrument_name?: string
  instrument_id?: number
  lims_sub_sample_pk?: number | null
}): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(`${API_BASE_URL()}/wizard/sessions`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.detail || `Create wizard session failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Create wizard session error:', error)
    throw error
  }
}

/**
 * Get a wizard session by ID.
 */
export async function getWizardSession(
  sessionId: number
): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/wizard/sessions/${sessionId}`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(
        `Get wizard session ${sessionId} failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Get wizard session ${sessionId} error:`, error)
    throw error
  }
}

/**
 * List wizard sessions (flat array, not paginated).
 */
export async function listWizardSessions(params?: {
  status?: string
  peptide_id?: number
  limit?: number
  offset?: number
}): Promise<WizardSessionListItem[]> {
  try {
    const urlParams = new URLSearchParams()
    if (params?.status) urlParams.set('status', params.status)
    if (params?.peptide_id != null)
      urlParams.set('peptide_id', String(params.peptide_id))
    if (params?.limit != null) urlParams.set('limit', String(params.limit))
    if (params?.offset != null) urlParams.set('offset', String(params.offset))

    const qs = urlParams.toString()
    const response = await fetch(
      `${API_BASE_URL()}/wizard/sessions${qs ? `?${qs}` : ''}`,
      { headers: getBearerHeaders() }
    )
    if (!response.ok) {
      throw new Error(`List wizard sessions failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('List wizard sessions error:', error)
    throw error
  }
}

/**
 * Record a weight measurement for a wizard session step.
 */
export async function recordWizardMeasurement(
  sessionId: number,
  data: { step_key: string; weight_mg: number; source: string; vial_number?: number }
): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/wizard/sessions/${sessionId}/measurements`,
      {
        method: 'POST',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify(data),
      }
    )
    if (!response.ok) {
      throw new Error(
        `Record wizard measurement for session ${sessionId} failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Record wizard measurement error:`, error)
    throw error
  }
}

/**
 * Update wizard session parameters.
 */
export async function updateWizardSession(
  sessionId: number,
  data: {
    sample_id_label?: string
    declared_weight_mg?: number
    target_conc_ug_ml?: number
    target_total_vol_ul?: number
    peak_area?: number
    vial_params?: Record<string, VialParams>
    is_standard?: boolean
    manufacturer?: string
    standard_notes?: string
    instrument_name?: string
    instrument_id?: number
  }
): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/wizard/sessions/${sessionId}`,
      {
        method: 'PATCH',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify(data),
      }
    )
    if (!response.ok) {
      throw new Error(
        `Update wizard session ${sessionId} failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Update wizard session ${sessionId} error:`, error)
    throw error
  }
}

/**
 * Complete a wizard session.
 */
export async function completeWizardSession(
  sessionId: number
): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(
      `${API_BASE_URL()}/wizard/sessions/${sessionId}/complete`,
      {
        method: 'POST',
        headers: getBearerHeaders(),
      }
    )
    if (!response.ok) {
      throw new Error(
        `Complete wizard session ${sessionId} failed: ${response.status}`
      )
    }
    return response.json()
  } catch (error) {
    console.error(`Complete wizard session ${sessionId} error:`, error)
    throw error
  }
}

// --- Sample Preps API ---

export interface AnalyteData {
  component_id: number | null
  abbreviation: string
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  stock_conc_ug_ml: number | null
  required_stock_vol_ul: number | null
  required_diluent_vol_ul: number | null
  actual_conc_ug_ml: number | null
}

export interface VialData {
  vial_number: number
  component_ids: number[]
  component_abbreviations: string[]
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  stock_vial_empty_mg: number | null
  stock_vial_loaded_mg: number | null
  stock_conc_ug_ml: number | null
  required_diluent_vol_ul: number | null
  required_stock_vol_ul: number | null
  dil_vial_empty_mg: number | null
  dil_vial_with_diluent_mg: number | null
  dil_vial_final_mg: number | null
  actual_conc_ug_ml: number | null
  actual_diluent_vol_ul: number | null
  actual_stock_vol_ul: number | null
  actual_total_vol_ul: number | null
  analyte_data?: AnalyteData[]
}

export interface SamplePrep {
  id: number
  sample_id: string                   // SP-YYYYMMDD-NNNN
  wizard_session_id: number | null
  peptide_id: number
  peptide_name: string | null
  peptide_abbreviation: string | null
  senaite_sample_id: string | null
  lims_sub_sample_pk: number | null
  declared_weight_mg: number | null
  target_conc_ug_ml: number | null
  target_total_vol_ul: number | null
  stock_vial_empty_mg: number | null
  stock_vial_loaded_mg: number | null
  stock_conc_ug_ml: number | null
  required_diluent_vol_ul: number | null
  required_stock_vol_ul: number | null
  dil_vial_empty_mg: number | null
  dil_vial_with_diluent_mg: number | null
  dil_vial_final_mg: number | null
  actual_conc_ug_ml: number | null
  actual_diluent_vol_ul: number | null
  actual_stock_vol_ul: number | null
  actual_total_vol_ul: number | null
  status: string
  notes: string | null
  is_blend: boolean
  components_json: ComponentBrief[] | null
  vial_data: VialData[] | null
  // Phase 09: Standard prep metadata
  is_standard: boolean
  manufacturer: string | null
  standard_notes: string | null
  instrument_name: string | null
  instrument_id: number | null
  created_at: string
  updated_at: string
  // User tracking
  created_by_user_id: number | null
  created_by_email: string | null
  updated_by_user_id: number | null
  updated_by_email: string | null
}

export async function createSamplePrep(
  wizardSessionId: number,
  notes?: string
): Promise<SamplePrep> {
  const response = await fetch(`${API_BASE_URL()}/sample-preps`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ wizard_session_id: wizardSessionId, notes }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Create sample prep failed: ${response.status} ${text}`)
  }
  return response.json()
}

export async function listSamplePreps(params?: {
  search?: string
  is_standard?: boolean
  limit?: number
  offset?: number
}): Promise<SamplePrep[]> {
  const qs = new URLSearchParams()
  if (params?.search) qs.set('search', params.search)
  if (params?.is_standard != null) qs.set('is_standard', String(params.is_standard))
  if (params?.limit != null) qs.set('limit', String(params.limit))
  if (params?.offset != null) qs.set('offset', String(params.offset))
  const response = await fetch(
    `${API_BASE_URL()}/sample-preps${qs.toString() ? '?' + qs : ''}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`List sample preps failed: ${response.status}`)
  return response.json()
}

export async function getSamplePrep(id: number): Promise<SamplePrep> {
  const response = await fetch(`${API_BASE_URL()}/sample-preps/${id}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Get sample prep ${id} failed: ${response.status}`)
  return response.json()
}

export async function updateSamplePrep(
  id: number,
  data: Partial<Pick<SamplePrep,
    | 'senaite_sample_id' | 'declared_weight_mg' | 'target_conc_ug_ml'
    | 'target_total_vol_ul' | 'status' | 'notes'
    | 'instrument_name' | 'manufacturer' | 'standard_notes'
  >>
): Promise<SamplePrep> {
  const response = await fetch(`${API_BASE_URL()}/sample-preps/${id}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Update sample prep ${id} failed: ${response.status}`)
  return response.json()
}

/**
 * Re-run the vial-prep result bridge for every HPLC analysis on a prep.
 * Idempotent server-side (only 'unassigned' vial rows are written). 409 when
 * the prep is parent-scoped or has no HPLC analyses yet.
 */
export async function rebridgeSamplePrep(
  prepId: number
): Promise<{ submitted: number[]; count: number }> {
  const response = await fetch(`${API_BASE_URL()}/hplc/sample-preps/${prepId}/bridge`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      typeof err?.detail === 'string'
        ? err.detail
        : `rebridgeSamplePrep failed: ${response.status}`
    )
  }
  return response.json()
}

export async function deleteSamplePrep(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/sample-preps/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Delete sample prep ${id} failed: ${response.status}`)
}

// --- HPLC Scan ---

export interface LocalHplcFile {
  filename: string
  content: string
  kind: 'peak' | 'chrom'
}

export interface HplcScanMatch {
  prep_id: number
  senaite_sample_id: string
  folder_name: string
  folder_id: string
  folder_web_url?: string | null
  peak_files: SharePointItem[]
  chrom_files: SharePointItem[]
  /** TRUE when the folder was hand-picked via the per-prep override (not
   *  found by the name-prefix scan). Display hint only. */
  is_override?: boolean
  /** Data source. Absent/'sharepoint' = files fetched from SharePoint by id.
   *  'local' = files were read client-side; see `local_files`. */
  source?: 'sharepoint' | 'local'
  /** Present only when source === 'local': the already-read file content.
   *  peak_files/chrom_files are [] for local matches. */
  local_files?: LocalHplcFile[]
}

export interface HplcFolderMatchResult {
  folder_name: string
  folder_path: string
  folder_id: string | null
  folder_web_url: string | null
  peak_files: SharePointItem[]
  chrom_files: SharePointItem[]
}

/**
 * Manual override for HPLC data discovery: run the scan's per-folder matching
 * against an arbitrary LIMS folder (recursive CSV listing + PeakData/
 * chromatogram filters). The caller binds the result to a prep client-side.
 */
export async function getHplcFolderMatch(
  folderPath: string
): Promise<HplcFolderMatchResult> {
  const params = new URLSearchParams({ folder_path: folderPath })
  const response = await fetch(
    `${API_BASE_URL()}/sample-preps/hplc-folder-match?${params}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      typeof err?.detail === 'string'
        ? err.detail
        : `getHplcFolderMatch failed: ${response.status}`
    )
  }
  return response.json()
}

export interface HplcScanLogLine {
  msg: string
  level: 'info' | 'dim' | 'warn' | 'success' | 'error'
}

/**
 * Opens a fetch-based SSE stream to GET /sample-preps/scan-hplc.
 * Returns a cancel function. Calls onDone/onError when finished.
 */
export function scanSamplePrepsHplc(opts: {
  onLog: (line: HplcScanLogLine) => void
  onMatch: (match: HplcScanMatch) => void
  onProgress: (current: number, total: number) => void
  onDone: (matches: HplcScanMatch[]) => void
  onError: (msg: string) => void
}): () => void {
  const abortController = new AbortController()

  ;(async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL()}/sample-preps/scan-hplc`,
        { headers: getBearerHeaders(), signal: abortController.signal }
      )
      if (!response.ok) {
        opts.onError(`Scan request failed: ${response.status}`)
        return
      }
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          let eventType = 'message', dataStr = ''
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim()
            else if (line.startsWith('data: ')) dataStr = line.slice(6).trim()
          }
          if (!dataStr) continue
          try {
            const data = JSON.parse(dataStr)
            if (eventType === 'log')      opts.onLog(data)
            else if (eventType === 'match')    opts.onMatch(data)
            else if (eventType === 'progress') opts.onProgress(data.current, data.total)
            else if (eventType === 'done')  { opts.onDone(data.matches); return }
            else if (eventType === 'error') { opts.onError(data.msg); return }
          } catch { /* ignore malformed SSE chunks */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        opts.onError(err instanceof Error ? err.message : 'SSE connection error')
    }
  })()

  return () => abortController.abort()
}

// --- SENAITE Lookup API ---

export interface SenaiteAnalyte {
  raw_name: string
  slot_number: number // 1-4, corresponding to Analyte1..Analyte4 in SENAITE
  matched_peptide_id: number | null
  matched_peptide_name: string | null
  declared_quantity: number | null // per-analyte declared qty (mg)
}

export interface SenaiteCOAInfo {
  company_logo_url: string | null
  chromatograph_background_url: string | null
  company_name: string | null
  email: string | null
  website: string | null
  address: string | null
  verification_code: string | null
}

export interface SenaiteRemark {
  content: string
  user_id: string | null
  created: string | null
}

export interface SenaiteResultOption {
  value: string
  label: string
}

export interface SenaiteAnalysis {
  uid: string | null
  keyword: string | null
  title: string
  result: string | null
  result_type?: string | null
  result_options: SenaiteResultOption[]  // always present from backend; [] if no predefined options
  unit: string | null
  method: string | null
  method_uid: string | null
  method_options: { uid: string; title: string }[]
  instrument: string | null
  instrument_uid: string | null
  instrument_options: { uid: string; title: string }[]
  analyst: string | null
  due_date: string | null
  review_state: string | null
  sort_key: number | null
  captured: string | null
  retested: boolean
  /** Mk1-local: service_group resolved from analysis_services by keyword.
   * Drives the "primary for this vial" highlight on the detail page. */
  service_group_id: number | null
  service_group_name: string | null
  // Phase 4b: when this vial-tier row has been promoted to a parent-tier
  // canonical result, this is the parent-tier row's id. Used to render
  // the "Promoted → #N" badge in AnalysisTable.
  promoted_to_parent_id?: number | null
}

export interface SenaiteAttachment {
  uid: string
  filename: string
  content_type: string | null
  attachment_type: string | null
  download_url: string | null
}

export interface SenaitePublishedCOA {
  report_uid: string
  filename: string
  file_size_bytes: number | null
  published_date: string | null
  published_by: string | null
  download_url: string
}

export interface SenaiteLookupResult {
  sample_id: string
  sample_uid: string | null
  client: string | null
  contact: string | null
  sample_type: string | null
  date_received: string | null
  date_sampled: string | null
  profiles: string[]
  client_order_number: string | null
  client_sample_id: string | null
  client_lot: string | null
  review_state: string | null
  declared_weight_mg: number | null
  analytes: SenaiteAnalyte[]
  coa: SenaiteCOAInfo
  remarks: SenaiteRemark[]
  analyses: SenaiteAnalysis[]
  attachments: SenaiteAttachment[]
  published_coa: SenaitePublishedCOA | null
  senaite_url: string | null
  cached_at: string | null
  /** Per-field provenance when read from the Mk1 registry (source==='mk1'). */
  field_sources?: Record<string, 'mk1' | 'senaite'>
  /** Present when the response was served from the Mk1 registry. */
  read_source?: 'mk1'
  /** True when a 'mk1' read fell back because no registry record exists yet. */
  registry_missing?: boolean
}

export interface SenaiteStatusResponse {
  enabled: boolean
}

export async function getSenaiteStatus(): Promise<SenaiteStatusResponse> {
  const response = await fetch(`${API_BASE_URL()}/wizard/senaite/status`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok)
    throw new Error(`SENAITE status check failed: ${response.status}`)
  return response.json()
}

// Concurrency limiter — caps in-flight SENAITE requests to avoid overwhelming the server.
function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0
  const queue: (() => void)[] = []

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>(resolve => queue.push(resolve))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = queue.shift()
      if (next) next()
    }
  }
}

const senaiteLimiter = createConcurrencyLimiter(3)

export async function clearSenaiteLookupCache(): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/lookup-cache`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error('Failed to clear Senaite cache')
}

export async function lookupSenaiteSample(
  sampleId: string,
  /** Pass false to use the 15-min server-side cache. Only Order Status page should do this. */
  noCache = true,
  /** 'mk1' reads from the Mk1 registry endpoint instead of the live SENAITE lookup. */
  source: 'senaite' | 'mk1' = 'senaite'
): Promise<SenaiteLookupResult> {
  const url = source === 'mk1'
    ? `${API_BASE_URL()}/registry/sample/${encodeURIComponent(sampleId)}/details`
    : `${API_BASE_URL()}/wizard/senaite/lookup?id=${encodeURIComponent(sampleId)}&no_cache=${noCache}`
  return senaiteLimiter(async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(
        url,
        { headers: getBearerHeaders(), signal: controller.signal }
      )
      if (!response.ok) {
        const err = await response.json().catch(() => null)
        throw new Error(err?.detail || `SENAITE lookup failed: ${response.status}`)
      }
      return response.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`SENAITE lookup timed out for ${sampleId}`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })
}

const _attachmentCache = new Map<string, string>()
const _attachmentTextCache = new Map<string, string>()

export async function fetchSenaiteAttachmentText(attachmentUid: string): Promise<string> {
  const cached = _attachmentTextCache.get(attachmentUid)
  if (cached) return cached

  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/attachment/${encodeURIComponent(attachmentUid)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Failed to fetch attachment: ${response.status}`)
  const text = await response.text()
  _attachmentTextCache.set(attachmentUid, text)
  return text
}

export async function fetchSenaiteAttachmentUrl(
  attachmentUid: string
): Promise<string> {
  const cached = _attachmentCache.get(attachmentUid)
  if (cached) return cached

  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/attachment/${encodeURIComponent(attachmentUid)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status}`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  _attachmentCache.set(attachmentUid, url)
  return url
}

export async function fetchSenaiteReportUrl(reportUid: string): Promise<string> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/report/${encodeURIComponent(reportUid)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Failed to fetch report: ${response.status}`)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

export type SenaiteAttachmentType = 'HPLC Graph' | 'Sample Image'

export interface SenaiteUploadAttachmentResponse {
  success: boolean
  message: string
}

export async function uploadSenaiteAttachment(
  sampleUid: string,
  file: File,
  attachmentType: SenaiteAttachmentType,
  nativeKind?: string,
  sourceSampleId?: string
): Promise<SenaiteUploadAttachmentResponse> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('attachment_type', attachmentType)
  if (nativeKind) form.append('native_kind', nativeKind)
  if (sourceSampleId) form.append('source_sample_id', sourceSampleId)

  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(sampleUid)}/attachments`,
    { method: 'POST', headers: getBearerHeaders(), body: form }
  )
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`)
  }
  return response.json() as Promise<SenaiteUploadAttachmentResponse>
}

export async function getChromatogramStatus(): Promise<{ prep_ids_with_chromatogram: number[] }> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/chromatogram-status`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Failed to fetch chromatogram status: ${response.status}`)
  return response.json()
}

export async function refetchChromatogram(analysisId: number): Promise<{ success: boolean; message: string; points?: number }> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/analyses/${analysisId}/refetch-chromatogram`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Refetch failed: ${response.status}`)
  }
  return response.json()
}

export async function renderChromatogramImage(analysisId: number): Promise<string> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/analyses/${analysisId}/chromatogram-image`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) {
    throw new Error(`Chromatogram render failed: ${response.status}`)
  }
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

export async function uploadChromatogramToSenaite(
  analysisId: number,
  sampleUid: string
): Promise<{ success: boolean; message: string; filename?: string; size_bytes?: number }> {
  const response = await fetch(
    `${API_BASE_URL()}/hplc/analyses/${analysisId}/chromatogram-to-senaite?sample_uid=${encodeURIComponent(sampleUid)}`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Chromatogram upload failed: ${response.status}`)
  }
  return response.json()
}

export interface SenaiteFieldUpdateResponse {
  success: boolean
  message: string
  updated_fields: string[] | null
}

export async function updateSenaiteSampleFields(
  uid: string,
  fields: Record<string, string | number | null>
): Promise<SenaiteFieldUpdateResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/samples/${encodeURIComponent(uid)}/update`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ fields }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE update failed: ${response.status}`)
  }
  return response.json()
}

export interface AnalysisResultResponse {
  success: boolean
  message: string
  new_review_state: string | null
  keyword: string | null
}

export async function setAnalysisResult(
  uid: string,
  result: string
): Promise<AnalysisResultResponse> {
  // Phase 3: route mk1:<id> UIDs to the Mk1 transitions endpoint with
  // kind=submit + result_value inline. The result-set + state-advance
  // happen atomically in one Mk1 transition.
  if (uid.startsWith('mk1:')) {
    const limsId = parseInt(uid.slice('mk1:'.length), 10)
    const response = await fetch(
      `${API_BASE_URL()}/api/lims-analyses/${limsId}/transitions`,
      {
        method: 'POST',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify({
          kind: 'submit',
          result_value: result,
          reason: 'bench-tech result entry',
        }),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.detail || `Set result (mk1) failed: ${response.status}`)
    }
    const row = await response.json()
    return {
      success: true,
      message: 'Result submitted via Mk1',
      new_review_state: row.review_state ?? null,
      keyword: row.keyword ?? null,
    }
  }
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/result`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ result }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Set result failed: ${response.status}`)
  }
  return response.json()
}

export async function setAnalysisMethodInstrument(
  uid: string,
  methodUid: string | null,
  instrumentUid: string | null
): Promise<AnalysisResultResponse> {
  // Phase 3.6: route mk1:<id> UIDs to the Mk1 method-instrument PATCH
  // endpoint. The Mk1 option uids are int-as-string (e.g. "1", "2");
  // parse them back to integers for the request body. Either may be
  // null (clear). The SENAITE-uid code path below is unchanged.
  if (uid.startsWith('mk1:')) {
    const limsId = parseInt(uid.slice('mk1:'.length), 10)
    const body = {
      method_id: methodUid ? parseInt(methodUid, 10) : null,
      instrument_id: instrumentUid ? parseInt(instrumentUid, 10) : null,
    }
    const response = await fetch(
      `${API_BASE_URL()}/api/lims-analyses/${limsId}/method-instrument`,
      {
        method: 'PATCH',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify(body),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.detail || `Set method/instrument (mk1) failed: ${response.status}`)
    }
    const row = await response.json()
    return {
      success: true,
      message: 'Method/instrument updated via Mk1',
      new_review_state: row.review_state ?? null,
      keyword: row.keyword ?? null,
    }
  }
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/method-instrument`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ method_uid: methodUid, instrument_uid: instrumentUid }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Set method/instrument failed: ${response.status}`)
  }
  return response.json()
}

export async function transitionAnalysis(
  uid: string,
  transition: 'submit' | 'verify' | 'retract' | 'reject' | 'retest' | 'variance_verify'
): Promise<AnalysisResultResponse> {
  // Phase 3: route mk1:<id> UIDs to the Mk1 transitions endpoint. The
  // 'retest' kind creates a linked retest row on the Mk1 side and returns
  // the NEW row (retest-aware promote phase).
  if (uid.startsWith('mk1:')) {
    const limsId = parseInt(uid.slice('mk1:'.length), 10)
    const response = await fetch(
      `${API_BASE_URL()}/api/lims-analyses/${limsId}/transitions`,
      {
        method: 'POST',
        headers: getBearerHeaders('application/json'),
        body: JSON.stringify({
          kind: transition,
          reason: `bench-tech ${transition}`,
        }),
      }
    )
    if (!response.ok) {
      const err = await response.json().catch(() => null)
      throw new Error(err?.detail || `Transition (mk1) failed: ${response.status}`)
    }
    const row = await response.json()
    return {
      success: true,
      message: `Transition '${transition}' applied via Mk1`,
      new_review_state: row.review_state ?? null,
      keyword: row.keyword ?? null,
    }
  }
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/analyses/${encodeURIComponent(uid)}/transition`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ transition }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Transition failed: ${response.status}`)
  }
  return response.json()
}

// ─── Phase 4b: promote_to_parent client ──────────────────────────────────────

export interface PromoteSourceRef {
  analysis_id: number
  contribution_kind: 'chosen' | 'aggregated_in' | 'reference'
}

export interface PromoteRequest {
  keyword: string
  result_value: string
  result_unit?: string | null
  method_id?: number | null
  instrument_id?: number | null
  sources: PromoteSourceRef[]
  reason?: string | null
}

export interface PromoteResponse {
  parent: {
    id: number
    review_state: string
    result_value: string | null
    result_unit: string | null
    keyword: string
    title: string
    lims_sample_pk: number | null
    [k: string]: unknown
  }
  promotions: Array<{
    id: number
    parent_analysis_id: number
    source_analysis_id: number
    contribution_kind: string
    promoted_at: string
    reason: string | null
  }>
}

/**
 * Phase 4b: promote N vial-tier sources to a single parent-tier verified row.
 *
 * Throws on non-2xx with a structured Error message including the backend's
 * detail (404 missing source, 409 parent_row_already_exists, 400 validation).
 */
export async function promoteAnalyses(req: PromoteRequest): Promise<PromoteResponse> {
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses/promote`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(req),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    const message = typeof detail === 'string'
      ? detail
      : detail?.message ?? `Promote failed: ${response.status}`
    throw new Error(message)
  }
  return response.json()
}

export interface SenaiteSample {
  uid: string
  id: string
  title: string
  client_id: string | null
  client_order_number: string | null
  date_created: string | null
  date_received: string | null
  date_sampled: string | null
  review_state: string
  sample_type: string | null
  contact: string | null
  verification_code: string | null
  analytes: string[]
}

export interface SenaiteSamplesResponse {
  items: SenaiteSample[]
  total: number
  b_start: number
}

export async function getSenaiteSamples(
  reviewState?: string,
  limit = 50,
  bStart = 0,
  search?: string,
  searchField?: 'verification_code' | 'order_number',
  /** Catalog-brains only (no complete=yes hydration on the SENAITE side).
   *  Items carry live review_state/id/uid but empty analytes/verification
   *  code. Only the mk1-read-mode list refresh passes this. */
  slim?: boolean
): Promise<SenaiteSamplesResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    b_start: String(bStart),
  })
  if (reviewState) params.set('review_state', reviewState)
  if (search) params.set('search', search)
  if (searchField) params.set('search_field', searchField)
  if (slim) params.set('slim', 'true')
  const response = await fetch(`${API_BASE_URL()}/senaite/samples?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE samples failed: ${response.status}`)
  }
  return response.json()
}

/** Fast samples-list read sourced from the local lims_samples registry
 *  (GET /registry/samples) instead of a live SENAITE round-trip. Same shape
 *  as getSenaiteSamples so callers can switch between them by read source. */
export async function getRegistrySamples(
  reviewState?: string,
  limit = 50,
  bStart = 0,
  search?: string,
  searchField?: 'verification_code' | 'order_number'
): Promise<SenaiteSamplesResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    b_start: String(bStart),
  })
  if (reviewState) params.set('review_state', reviewState)
  if (search) params.set('search', search)
  if (searchField) params.set('search_field', searchField)
  const response = await fetch(`${API_BASE_URL()}/registry/samples?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Registry samples failed: ${response.status}`)
  }
  return response.json()
}

export interface SenaiteReceiveSampleResponse {
  success: boolean
  message: string
  senaite_response: Record<string, unknown> | null
}

export async function receiveSenaiteSample(
  sampleUid: string,
  sampleId: string,
  imageBase64: string | null,
  remarks: string | null
): Promise<SenaiteReceiveSampleResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/receive-sample`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        sample_uid: sampleUid,
        sample_id: sampleId,
        image_base64: imageBase64,
        remarks,
      }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Receive sample failed: ${response.status}`)
  }
  return response.json()
}

// --- SharePoint Integration ---

export interface SharePointItem {
  id: string
  name: string
  type: 'folder' | 'file'
  size: number
  created: string | null
  last_modified: string | null
  child_count: number | null
  mime_type: string | null
}

export interface SharePointBrowseResult {
  path: string
  root: string
  items: SharePointItem[]
}

export interface SharePointStatus {
  status: 'connected' | 'error'
  site_id?: string
  drive_id?: string
  peptides_path?: string
  peptide_folders?: string[]
  error?: string
}

export interface SharePointDownloadedFile {
  id: string
  filename: string
  content: string
}

export async function getSharePointStatus(): Promise<SharePointStatus> {
  const response = await fetch(`${API_BASE_URL()}/sharepoint/status`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`SharePoint status check failed: ${response.status}`)
  }
  return response.json()
}

export async function browseSharePoint(
  path: string = '',
  root: 'lims' | 'peptides' = 'lims'
): Promise<SharePointBrowseResult> {
  const params = new URLSearchParams({ path, root })
  const response = await fetch(
    `${API_BASE_URL()}/sharepoint/browse?${params}`,
    {
      headers: getBearerHeaders(),
    }
  )
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`SharePoint browse failed: ${response.status} — ${detail}`)
  }
  return response.json()
}

export async function getFolderChromFiles(folderId: string): Promise<SharePointItem[]> {
  const response = await fetch(
    `${API_BASE_URL()}/sharepoint/folder-by-id/${encodeURIComponent(folderId)}/chrom-files`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Chrom file lookup failed: ${response.status}`)
  const data = await response.json()
  return data.files as SharePointItem[]
}

export async function downloadSharePointFiles(
  fileIds: string[]
): Promise<SharePointDownloadedFile[]> {
  const response = await fetch(`${API_BASE_URL()}/sharepoint/download-batch`, {
    method: 'POST',
    headers: {
      ...getBearerHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fileIds),
  })
  if (!response.ok) {
    throw new Error(`SharePoint batch download failed: ${response.status}`)
  }
  const data = await response.json()
  return data.files
}

// ─── Service Groups ───────────────────────────────────────────────────────────

export interface ServiceGroup {
  id: number
  name: string
  description: string | null
  color: string
  sort_order: number
  is_default: boolean
  sla_tier_id: number | null
  member_count: number
  member_ids: number[]
  created_at: string
  updated_at: string
}

export interface ServiceGroupCreate {
  name: string
  description?: string | null
  color?: string
  sort_order?: number
  is_default?: boolean
  sla_tier_id?: number | null
}

export interface ServiceGroupUpdate {
  name?: string
  description?: string | null
  color?: string
  sort_order?: number
  is_default?: boolean
  sla_tier_id?: number | null
}

export interface SenaiteAnalyst {
  uid: string
  username: string | null
  fullname: string
}

export async function getServiceGroups(): Promise<ServiceGroup[]> {
  const response = await fetch(`${API_BASE_URL()}/service-groups`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to load service groups: ${response.status}`)
  return response.json()
}

export async function createServiceGroup(data: ServiceGroupCreate): Promise<ServiceGroup> {
  const response = await fetch(`${API_BASE_URL()}/service-groups`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to create service group: ${response.status}`)
  return response.json()
}

export async function updateServiceGroup(id: number, data: ServiceGroupUpdate): Promise<ServiceGroup> {
  const response = await fetch(`${API_BASE_URL()}/service-groups/${id}`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to update service group: ${response.status}`)
  return response.json()
}

export async function deleteServiceGroup(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/service-groups/${id}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to delete service group: ${response.status}`)
}

export async function getServiceGroupMembers(groupId: number): Promise<number[]> {
  const response = await fetch(`${API_BASE_URL()}/service-groups/${groupId}/members`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to load service group members: ${response.status}`)
  return response.json()
}

export async function setServiceGroupMembers(
  groupId: number,
  analysisServiceIds: number[]
): Promise<{ count: number }> {
  const response = await fetch(`${API_BASE_URL()}/service-groups/${groupId}/members`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ analysis_service_ids: analysisServiceIds }),
  })
  if (!response.ok) throw new Error(`Failed to update service group members: ${response.status}`)
  return response.json()
}

// ─── SLA tiers (sub-project A revised + C) ──────────────────────────────────

export interface SlaTier {
  id: number
  name: string
  target_minutes: number
  business_hours_only: boolean
  is_default: boolean
  amber_threshold_percent: number
  created_at: string
  updated_at: string
}

export interface SlaTierCreate {
  name: string
  target_minutes: number
  business_hours_only?: boolean
  is_default?: boolean
  amber_threshold_percent?: number
}

export interface SlaTierUpdate {
  name?: string
  target_minutes?: number
  business_hours_only?: boolean
  is_default?: boolean
  amber_threshold_percent?: number
}

export interface SlaPriorityTier {
  id: number
  priority: InboxPriority
  sla_tier_id: number
  // Multi-tier follow-on: null = global override for this priority; an integer
  // scopes the override to a single service group. Precedence on the resolver:
  // (priority, group_id) > (priority, NULL) > group's own tier > default.
  service_group_id: number | null
}

export async function getSlaTiers(): Promise<SlaTier[]> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load SLA tiers: ${response.status}`)
  return response.json()
}

export async function createSlaTier(data: SlaTierCreate): Promise<SlaTier> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to create SLA tier: ${response.status}`)
  return response.json()
}

export async function updateSlaTier(id: number, data: SlaTierUpdate): Promise<SlaTier> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers/${id}`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to update SLA tier: ${response.status}`)
  return response.json()
}

export async function deleteSlaTier(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/sla-tiers/${id}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to delete SLA tier: ${response.status}`)
}

export async function getSlaPriorityTiers(): Promise<SlaPriorityTier[]> {
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load priority overrides: ${response.status}`)
  return response.json()
}

export async function setSlaPriorityTier(
  priority: InboxPriority,
  slaTierId: number,
  serviceGroupId?: number | null,
): Promise<SlaPriorityTier> {
  // Omit service_group_id entirely (rather than send null) when the caller is
  // setting the global override — matches the existing single-arg call sites
  // and keeps the request body slim.
  const body: { sla_tier_id: number; service_group_id?: number | null } = { sla_tier_id: slaTierId }
  if (serviceGroupId != null) body.service_group_id = serviceGroupId
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers/${priority}`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Failed to set priority override: ${response.status}`)
  return response.json()
}

export async function deleteSlaPriorityTier(
  priority: InboxPriority,
  serviceGroupId?: number | null,
): Promise<void> {
  // Without serviceGroupId, deletes the global (NULL group) override; with it,
  // deletes only the per-group row.
  const params = new URLSearchParams()
  if (serviceGroupId != null) params.set('service_group_id', String(serviceGroupId))
  const qs = params.toString()
  const response = await fetch(`${API_BASE_URL()}/sla-priority-tiers/${priority}${qs ? `?${qs}` : ''}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to remove priority override: ${response.status}`)
}

/**
 * Client-side SLA resolution — TS mirror of the Python resolve_sla_tier.
 * Precedence: priority override > group tier > default. priorityMap is sparse
 * (a key exists only for overriding priorities). D2 caches getSlaTiers() +
 * getSlaPriorityTiers() and resolves per sample here. Keep in lockstep with
 * backend/sla_engine.py.
 */
export function resolveSlaTier(
  priorityMap: Partial<Record<InboxPriority, SlaTier>>,
  groupTier: SlaTier | null,
  priority: InboxPriority | null,
  defaultTier: SlaTier | null
): SlaTier | null {
  const prioTier = priority ? priorityMap[priority] : undefined
  if (prioTier) return prioTier
  if (groupTier) return groupTier
  return defaultTier
}

// ─── Business-hours config + holidays + batch status (sub-project B) ──────────

export interface BusinessHoursConfig {
  open_time: string // "HH:MM:SS"
  close_time: string
  timezone: string
  working_days: number[] // Python weekday ints, Mon=0..Sun=6
}

export interface LabHoliday {
  id: number
  holiday_date: string // "YYYY-MM-DD"
  name: string
  source: 'federal' | 'custom'
}

export interface SlaStatusRequestItem {
  key: string
  received_at: string | null
  target_minutes: number
  business_hours_only: boolean
  /** Historical mode for published samples — when set, the server uses this as
   *  "now" instead of wall-clock UTC so elapsed = (published - received). Used
   *  by SampleHeaderSla on published samples to show "took Xh / Met / Missed". */
  now_override?: string | null
}

export interface SlaStatus {
  target_minutes: number
  elapsed_minutes: number
  remaining_minutes: number
  breached: boolean
}

export interface SlaStatusResultItem {
  key: string
  status: SlaStatus | null
}

export async function getBusinessHoursConfig(): Promise<BusinessHoursConfig> {
  const response = await fetch(`${API_BASE_URL()}/business-hours-config`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load business hours: ${response.status}`)
  return response.json()
}

export async function updateBusinessHoursConfig(data: BusinessHoursConfig): Promise<BusinessHoursConfig> {
  const response = await fetch(`${API_BASE_URL()}/business-hours-config`, {
    method: 'PUT', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to save business hours: ${response.status}`)
  return response.json()
}

export async function getLabHolidays(year: number): Promise<LabHoliday[]> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays?year=${year}`, { headers: getBearerHeaders() })
  if (!response.ok) throw new Error(`Failed to load holidays: ${response.status}`)
  return response.json()
}

export async function createLabHoliday(data: { holiday_date: string; name: string }): Promise<LabHoliday> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Failed to add holiday: ${response.status}`)
  return response.json()
}

export async function deleteLabHoliday(holidayDate: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays/${holidayDate}`, {
    method: 'DELETE', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to remove holiday: ${response.status}`)
}

export async function generateFederalHolidays(year: number): Promise<{ year: number; added: number }> {
  const response = await fetch(`${API_BASE_URL()}/lab-holidays/generate-federal?year=${year}`, {
    method: 'POST', headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to generate federal holidays: ${response.status}`)
  return response.json()
}

export async function fetchSlaStatuses(items: SlaStatusRequestItem[]): Promise<SlaStatusResultItem[]> {
  const response = await fetch(`${API_BASE_URL()}/sla/status`, {
    method: 'POST', headers: getBearerHeaders('application/json'), body: JSON.stringify({ items }),
  })
  if (!response.ok) throw new Error(`Failed to fetch SLA statuses: ${response.status}`)
  const data = await response.json()
  return data.items
}

// ─── D2: bulk per-sample priority lookup ─────────────────────────────────────

export interface SamplePriorityLookupItem {
  sample_uid: string
  priority: InboxPriority
}

export async function samplePrioritiesLookup(
  sampleUids: string[]
): Promise<SamplePriorityLookupItem[]> {
  if (sampleUids.length === 0) return []
  const response = await fetch(`${API_BASE_URL()}/sample-priorities/lookup`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ sample_uids: sampleUids }),
  })
  if (!response.ok) {
    throw new Error(`Failed to lookup sample priorities: ${response.status}`)
  }
  const data = await response.json()
  return data.items
}

export async function getSenaiteAnalysts(): Promise<SenaiteAnalyst[]> {
  const response = await fetch(`${API_BASE_URL()}/senaite/analysts`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Failed to load analysts: ${response.status}`)
  return response.json()
}

// NOTE: SENAITE Analyst field is read-only — analyst assignment lives in
// AccuMark's local worksheet_items table, not pushed to SENAITE.

// ─── Inbox Types ─────────────────────────────────────────────────────────────

export type InboxPriority = 'normal' | 'high' | 'expedited'

export type InboxRole = 'hplc' | 'microbiology'

// Aligns with backend Pydantic InboxAnalysisItem after the vial-inbox
// redesign — service group context now travels per-analysis.
export interface InboxAnalysisItem {
  uid: string | null
  title: string
  keyword: string | null
  peptide_name: string | null
  method: string | null
  review_state: string | null
  group_id: number
  group_name: string
  group_color: string
}

// One inbox card == one vial (parent AR or sub-sample AR). Replaces the
// old InboxSampleItem + analyses_by_group nesting.
export interface InboxVialItem {
  uid: string
  sample_id: string
  is_parent: boolean
  parent_sample_id: string
  assignment_role: string | null
  /** 'core' | 'variance' | null — explicit per-vial variance marker set at
   *  check-in. Parents are always null. */
  assignment_kind?: 'core' | 'variance' | null
  vial_sequence: number
  /** Family size: legacy = parent + subs; container = physical subs only. */
  vial_total: number
  /** Container family: vial position = vial_sequence (S01 IS Vial 1). */
  container_mode?: boolean
  title: string
  client_id: string | null
  client_order_number: string | null
  date_received: string | null
  review_state: string
  priority: InboxPriority
  assignment_summary: string
  analyses: InboxAnalysisItem[]
}

export interface InboxResponse {
  items: InboxVialItem[]
  total: number
  filter_role: InboxRole | null
}

export interface WorksheetUser {
  id: number
  email: string
  first_name?: string | null
  last_name?: string | null
  /** Slack profile photo (image_72) when the user is Slack-linked; null → the
   *  FE keeps the colored-initials avatar. Shared with the worksheets UI. */
  avatar_url?: string | null
}

export interface WorksheetCreateResponse {
  id: number
  title: string
  status: string
  item_count: number
}

// ─── Inbox API Functions ──────────────────────────────────────────────────────

export interface GetInboxOptions {
  hideTestOrders?: boolean
  forceRefresh?: boolean
  hidePrepped?: boolean
  role?: InboxRole | null
  showXtra?: boolean
  /** Read source for candidate samples + parent analyses: 'mk1' = local
   *  registry (no SENAITE round-trips), omitted/'senaite' = legacy SENAITE
   *  fetch. Resolved by callers from the 'worksheets_inbox' read-source
   *  setting. */
  source?: 'senaite' | 'mk1'
}

export async function getInboxSamples(opts: GetInboxOptions = {}): Promise<InboxResponse> {
  const {
    hideTestOrders = true,
    forceRefresh = false,
    hidePrepped = true,
    role = null,
    showXtra = false,
    source,
  } = opts
  const params = new URLSearchParams()
  params.set('hide_test_orders', String(hideTestOrders))
  params.set('hide_prepped', String(hidePrepped))
  if (forceRefresh) params.set('force_refresh', 'true')
  if (role) params.set('role', role)
  if (showXtra) params.set('show_xtra', 'true')
  if (source) params.set('source', source)
  const response = await fetch(`${API_BASE_URL()}/worksheets/inbox?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Inbox fetch failed: ${response.status}`)
  return response.json()
}

export async function updateInboxPriority(sampleUid: string, priority: InboxPriority): Promise<void> {
  // sample_uid travels in the BODY, not the path: Mk1-native UIDs are
  // `mk1://<hex>` and a slash-bearing UID in a path segment gets mangled by the
  // nginx proxy (encoded `://` -> decoded + slash-merged -> wrong route -> 404).
  const response = await fetch(`${API_BASE_URL()}/worksheets/inbox/priority`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ sample_uid: sampleUid, priority }),
  })
  if (!response.ok) throw new Error(`Priority update failed: ${response.status}`)
}

export async function getWorksheetUsers(): Promise<WorksheetUser[]> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/users`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Users fetch failed: ${response.status}`)
  return response.json()
}

export async function bulkUpdateInbox(data: {
  sample_uids: string[]
  priority?: InboxPriority
  service_group_id?: number
  analyst_id?: number
  instrument_uid?: string
}): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/inbox/bulk`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Bulk update failed: ${response.status}`)
}

export async function createWorksheet(data: {
  title: string
  sample_uids: string[]
  notes?: string
}): Promise<WorksheetCreateResponse> {
  const response = await fetch(`${API_BASE_URL()}/worksheets`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (response.status === 409) {
    const body = await response.json()
    throw Object.assign(new Error('Stale samples detected'), { staleUids: body.stale_uids })
  }
  if (!response.ok) throw new Error(`Worksheet creation failed: ${response.status}`)
  return response.json()
}

export interface WorksheetListItem {
  id: number
  title: string
  status: string
  notes: string | null
  assigned_analyst: number | null
  assigned_analyst_email: string | null
  item_count: number
  created_at: string | null
  completed_at: string | null
  items: {
    id: number
    sample_id: string
    sample_uid: string
    service_group_id: number | null
    group_name: string
    group_color: string
    priority: string
    added_at: string | null
    date_received: string | null
    instrument_uid: string | null
    assigned_analyst_id: number | null
    assigned_analyst_email: string | null
    notes: string | null
    peptide_id: number | null
    method_name: string | null
    lims_sub_sample_pk: number | null
    /** 'core' | 'variance' | null — null for parent-sample items. */
    assignment_kind?: 'core' | 'variance' | null
    /** Current physical box; null for parent-sample items / unboxed vials. */
    box_id: number | null
    box_label: string | null
    analyses: {
      title: string
      keyword: string | null
      peptide_name: string | null
      method: string | null
    }[]
    prep_status: string
  }[]
}

export async function listWorksheets(status?: string): Promise<WorksheetListItem[]> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  const qs = params.toString()
  const response = await fetch(`${API_BASE_URL()}/worksheets${qs ? `?${qs}` : ''}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`List worksheets failed: ${response.status}`)
  return response.json()
}

export async function removeWorksheetItem(
  worksheetId: number,
  itemId: number
): Promise<void> {
  // Keyed on the integer worksheet_items.id, NOT sample_uid/service_group_id:
  // Mk1-native UIDs are `mk1://<hex>` and a slash-bearing UID in a path segment
  // gets mangled by the nginx proxy into extra segments -> no route match -> 404.
  const response = await fetch(
    `${API_BASE_URL()}/worksheets/${worksheetId}/items/${itemId}`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Remove item failed: ${response.status}`)
}

export async function deleteWorksheet(worksheetId: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}`, {
    method: 'DELETE',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Delete worksheet failed: ${response.status}`)
}

export async function updateWorksheet(
  worksheetId: number,
  data: { title?: string; assigned_analyst?: number; notes?: string }
): Promise<void> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Update worksheet failed: ${response.status}`)
}

export async function addGroupToWorksheet(
  worksheetId: number,
  data: { sample_uid: string; sample_id: string; service_group_id: number; date_received?: string | null; analyses?: { title: string; keyword?: string | null; peptide_name?: string | null; method?: string | null }[] }
): Promise<{ status: string; item_id: number }> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}/add-group`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    if (response.status === 409) {
      const detail = await response.json().catch(() => null)
      throw new Error(detail?.detail ?? 'Sample already assigned to another worksheet')
    }
    throw new Error(`Add to worksheet failed: ${response.status}`)
  }
  return response.json()
}

export async function completeWorksheet(worksheetId: number): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}/complete`, {
    method: 'POST',
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Complete worksheet failed: ${response.status}`)
  return response.json()
}

export async function reassignWorksheetItem(
  worksheetId: number,
  itemId: number,
  targetWorksheetId: number
): Promise<{ status: string; target_worksheet_id: number }> {
  // By integer item id — see removeWorksheetItem for why native `mk1://` UIDs
  // can't ride in a path segment.
  const response = await fetch(
    `${API_BASE_URL()}/worksheets/${worksheetId}/items/${itemId}/reassign`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ target_worksheet_id: targetWorksheetId }),
    }
  )
  if (!response.ok) throw new Error(`Reassign item failed: ${response.status}`)
  return response.json()
}

export async function updateWorksheetItem(
  worksheetId: number,
  itemId: number,
  data: { instrument_uid?: string; prep_status?: string }
): Promise<{ status: string; item_id: number }> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}/items/${itemId}`, {
    method: 'PATCH',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Update item failed: ${response.status}`)
  return response.json()
}

export async function reorderWorksheetItems(
  worksheetId: number,
  itemIds: number[]
): Promise<{ status: string; count: number }> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/${worksheetId}/reorder`, {
    method: 'PUT',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({ item_ids: itemIds }),
  })
  if (!response.ok) throw new Error(`Reorder failed: ${response.status}`)
  return response.json()
}

export async function createWorksheetFromDrop(
  data: { sample_uid: string; sample_id: string; service_group_id: number; date_received?: string | null; analyses?: { title: string; keyword?: string | null; peptide_name?: string | null; method?: string | null }[] }
): Promise<WorksheetCreateResponse> {
  const response = await fetch(`${API_BASE_URL()}/worksheets/create-from-drop`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    if (response.status === 409) {
      const detail = await response.json().catch(() => null)
      throw new Error(detail?.detail ?? 'Sample already assigned to another worksheet')
    }
    throw new Error(`Create worksheet failed: ${response.status}`)
  }
  return response.json()
}

// ── Reports API ─────────────────────────────────────────────────

export interface ReportsSummary {
  total_peptides: number
  total_coas: number
  conforming: number
  non_conforming: number
}

export interface PeptideCard {
  analyte_name: string
  is_blend: boolean
  total_coas: number
  additional_coas: number
  conforming: number
  non_conforming: number
  most_recent_code: string | null
  most_recent_sample: string | null
  most_recent_status: string | null
  most_recent_date: string | null
  most_recent_lot: string | null
}

export interface ReportsDashboard {
  summary: ReportsSummary
  peptides: PeptideCard[]
  blends: PeptideCard[]
}

export interface PurityTrendPoint {
  date: string
  purity_percent: number
  sample_id: string
  verification_code: string
  conforms: boolean | null
}

export async function getReportsDashboard(): Promise<ReportsDashboard> {
  const response = await fetch(`${API_BASE_URL()}/reports/dashboard`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Reports dashboard failed: ${response.status}`)
  return response.json()
}

export async function getReportsPurityTrend(analyteName: string, isBlend = false): Promise<PurityTrendPoint[]> {
  const params = isBlend ? '?is_blend=true' : ''
  const response = await fetch(
    `${API_BASE_URL()}/reports/purity-trend/${encodeURIComponent(analyteName)}${params}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`Purity trend failed: ${response.status}`)
  return response.json()
}

// ─── Check-In Times ──────────────────────────────────────────────────────────

export interface CheckInRecord {
  sample_id: string
  sample_uid: string
  date_received: string // ISO 8601 UTC, trailing "Z"
  product_label: string | null
  priority: string
  is_test_order: boolean
}

export async function getCheckInTimes(from?: string, to?: string): Promise<CheckInRecord[]> {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  const response = await fetch(`${API_BASE_URL()}/reports/checkin-times${suffix}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Check-in times failed: ${response.status}`)
  return response.json()
}

// ─── Phase Turnaround (Bottlenecks) ──────────────────────────────────────────

export interface TurnaroundSample {
  sample_id: string
  ordered_at: string | null
  received_at: string | null
  submitted_at: string | null
  verified_at: string | null
  published_at: string | null
  is_test_order: boolean
}

export async function getTurnaround(): Promise<TurnaroundSample[]> {
  const response = await fetch(`${API_BASE_URL()}/reports/turnaround`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) throw new Error(`Turnaround failed: ${response.status}`)
  return response.json()
}

// ─── Sample Activity Timeline ────────────────────────────────────────────────

export interface SampleActivityEvent {
  timestamp: string | null
  event: string
  label: string
  details: Record<string, unknown>
  source: string
}

export interface SampleActivityResponse {
  sample_id: string
  events: SampleActivityEvent[]
  count: number
}

export async function getSampleActivity(sampleId: string): Promise<SampleActivityResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/samples/${encodeURIComponent(sampleId)}/activity`,
    { headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error(`Sample activity failed: ${response.status}`)
  return response.json()
}

// ─── Registry Debug Panel (admin) ────────────────────────────────────────────

export type RegistryFieldStatus = 'agree' | 'drift' | 'registry_null' | 'senaite_null'

export interface RegistryDebugField {
  field: string
  registry: unknown
  senaite: unknown
  status: RegistryFieldStatus
}

// Task 10: registry-inspect analyses sync column (parent analysis line
// items — SENAITE current line vs native lims_analyses shadow/canonical).
export type AnalysisSyncStatus = 'in_sync' | 'drift' | 'no_shadow' | 'shadow_only'

export interface AnalysisSyncRow {
  keyword: string
  title: string
  senaite: { review_state: string | null; result: string | null } | null
  shadow: { mirror_review_state: string | null; result: string | null } | null
  canonical: { review_state: string | null; result: string | null } | null
  status: AnalysisSyncStatus
}

export interface AnalysesSync {
  rows: AnalysisSyncRow[]
  summary: { senaite: number; shadow: number; in_sync: number; drift: number; missing: number } | null
  error: string | null
}

// Task 8: registry-inspect recent-transitions tail — last 5 native
// lims_sample_transitions rows for this parent, newest first.
export interface SampleTransitionRow {
  verb: string | null
  from_status: string | null
  to_status: string
  source: string
  occurred_at: string
}

export interface SampleTransitionsTail {
  rows: SampleTransitionRow[]
  error: string | null
  // UAT fast-follow: transition-log-vs-status sync check. `latest_to_status`
  // is the newest logged row's to_status (or null if no rows). `log_in_sync`
  // is null when there's no log yet, else whether latest_to_status matches
  // the registry's current status. `current_status` is that current status,
  // carried here so the panel doesn't need to derive it from the field diff
  // (which is empty on the senaite-missing path).
  latest_to_status: string | null
  log_in_sync: boolean | null
  current_status: string | null
}

export interface SampleRegistryDebug {
  sample_id: string
  load: {
    exists: boolean
    native_id: string | null
    external_lims_system: string | null
    last_synced_at: string | null
    age_seconds: number | null
    reconcile_due: boolean | null
  }
  linkage: { registry_uid: string | null; senaite_uid: string | null; status: string } | null
  origin: string | null
  container: { container_mode: boolean; assignment_role: string } | null
  fields: RegistryDebugField[]
  summary: { agree: number; drift: number; registry_null: number; senaite_null: number } | null
  vials: { local: number; senaite: number; status: string } | null
  verdict: { linkage_ok: boolean; vials_ok: boolean | null; drift: number; registry_null: number } | null
  senaite_error: string | null
  raw: { registry: Record<string, unknown> | null; senaite: Record<string, unknown> | null } | null
  analyses: AnalysesSync | null
  transitions: SampleTransitionsTail | null
}

export async function getSampleRegistryDebug(sampleId: string): Promise<SampleRegistryDebug> {
  return apiFetch<SampleRegistryDebug>(`/debug/sample-registry/${encodeURIComponent(sampleId)}`)
}

export async function refreshSampleRegistry(sampleId: string): Promise<SampleRegistryDebug> {
  return apiFetch<SampleRegistryDebug>(
    `/debug/sample-registry/${encodeURIComponent(sampleId)}/refresh`,
    { method: 'POST' },
  )
}

// ─── Sample Retest Info ──────────────────────────────────────────────────────

export interface RetestForwardLink {
  sample_id: string
  order_id: number | null
  created_at: string | null
}

export interface SampleRetestInfo {
  sample_id: string
  // True when this sample was created as a retest of another.
  is_retest: boolean
  // Populated when is_retest === true:
  source_sample_id: string | null
  source_order_id: number | null
  this_order_id: number | null
  retest_created_at: string | null
  // Samples that are retests of THIS one (chain-forward, may be empty).
  retested_as: RetestForwardLink[]
}

export async function getSampleRetestInfo(sampleId: string): Promise<SampleRetestInfo> {
  const response = await fetch(
    `${API_BASE_URL()}/samples/${encodeURIComponent(sampleId)}/retest-info`,
    { headers: getAuthHeaders() }
  )
  if (!response.ok) throw new Error(`Sample retest-info failed: ${response.status}`)
  return response.json()
}

// ─── Sub-samples ──────────────────────────────────────────────────────────

export interface SubSample {
  id: number
  sample_id: string
  parent_sample_id: string
  /** Kind of assignment for this vial: 'core' | 'variance' | null (null = xtra/unassigned).
   *  Set by the PATCH /assignment endpoint and returned in vial-plan GET. */
  assignment_kind?: 'core' | 'variance' | null
  vial_sequence: number
  received_at: string
  received_by_user_id: number | null
  /** Receiver display name — who checked the vial in (and took its check-in
   *  photo). Populated by the LIST endpoint; optional for back-compat. */
  received_by?: string | null
  photo_external_uid: string | null
  remarks: string | null
  assignment_role: AssignmentRole | null
  // Provenance: 'mk1://...' for Model-D native vials (no SENAITE AR), a SENAITE
  // hex UID for legacy dual-written vials. Used to load native vials from Mk1
  // without calling SENAITE. Optional for back-compat with older responses.
  external_lims_uid?: string | null
  // FK to lims_boxes.id — which physical box this vial is assigned to, or null
  // when unboxed. Drives the boxing UI's per-box vial chips.
  box_id?: number | null
  // Human box label ("BOX-<order#>-<box_number>", e.g. "BOX-3267-1"). Only the
  // list endpoint populates it; null/absent when unboxed.
  box_label?: string | null
}

export interface ParentSampleSummary {
  sample_id: string
  external_lims_uid: string | null
  peptide_name: string | null
  status: string | null
  sub_sample_count: number
  last_synced_at: string
  assignment_role: string | null
  /** TRUE = container family: parent is a pure report depository, S01 is
   *  Vial 1, no parent bench affordances (container-parent design). */
  container_mode: boolean
  /** Customer-facing remarks delivered with the published COA. */
  customer_remarks?: string | null
  /** "Include with Publish?" — whether the remark ships with the COA (default true). */
  customer_remarks_include?: boolean
  /** Set when a COA was generated with remarks included; surfaced as "Delivered on". */
  customer_remarks_delivered_at?: string | null
}

export interface SubSampleListResponse {
  parent: ParentSampleSummary
  sub_samples: SubSample[]
}

export type AssignmentRole = 'hplc' | 'endo' | 'ster' | 'xtra'

export interface VialPlanItem {
  sample_id: string
  is_parent: boolean
  vial_sequence: number
  assignment_role: AssignmentRole | null
  /** Kind of assignment: 'core' | 'variance' | null (null = xtra/unassigned).
   *  Set by the backend auto-assign and PATCH /assignment endpoint. */
  assignment_kind?: 'core' | 'variance' | null
}

export interface VialPlanResponse {
  /** Base (core) vial demand per role — NOT inflated by variance. */
  demand: { hplc: number; endo: number; ster: number }
  /** Per-role variance target: count of variance vials IN ADDITION to core
   *  demand (zeros when none purchased). Display-only paid marker for the
   *  AssignStep variance drop zones — never a drop blocker. */
  variance: { hplc: number; endo: number; ster: number }
  /** Pre-variance lab baseline; equals demand under the separate-bucket
   *  contract. Kept for back-compat. */
  base_demand: { hplc: number; endo: number; ster: number }
  wp_order_number: string | null
  vials: VialPlanItem[]
  is_unreachable: boolean
  /** Container family: parent is a pure depository — `vials` contains no
   *  parent entry when true (legacy families list the parent first). */
  container_mode?: boolean
}

/**
 * Thrown when SENAITE silently created a non-secondary AR (orphan).
 * Carries the orphan AR's identifiers so the UI can prompt for manual cleanup.
 */
export class SecondaryFalloutError extends Error {
  readonly orphan_uid: string
  readonly orphan_sample_id: string
  constructor(message: string, orphan_uid: string, orphan_sample_id: string) {
    super(message)
    this.name = 'SecondaryFalloutError'
    this.orphan_uid = orphan_uid
    this.orphan_sample_id = orphan_sample_id
  }
}

/**
 * List all sub-samples for a parent sample.
 */
/** Materialize the parent's lims_samples row (lazy upsert) and return its
 *  summary with an AUTHORITATIVE container_mode. The receive wizard calls
 *  this on mount — the list endpoint's missing-parent fallback reports
 *  container_mode=false, which must not drive the first-vial save decision. */
export async function ensureParentSampleRow(parentSampleId: string): Promise<ParentSampleSummary> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/ensure`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`ensureParentSampleRow failed: ${response.status}`)
  return response.json()
}

export async function listSubSamples(parentSampleId: string): Promise<SubSampleListResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples?parent_sample_id=${encodeURIComponent(parentSampleId)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) throw new Error(`listSubSamples failed: ${response.status}`)
  return response.json()
}

/** Set the parent's customer-facing remarks + whether they're delivered with the COA. */
export async function updateCustomerRemarks(
  parentSampleId: string,
  remarks: string,
  include: boolean,
): Promise<{ sample_id: string; customer_remarks: string; customer_remarks_include: boolean }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/parent/${encodeURIComponent(parentSampleId)}/customer-remarks`,
    {
      method: 'PUT',
      headers: { ...getBearerHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ remarks, include }),
    }
  )
  if (!response.ok) throw new Error(`updateCustomerRemarks failed: ${response.status}`)
  return response.json()
}

/**
 * Phase 3: fetch lims_analyses rows for a sub-sample, projected to the
 * SenaiteAnalysis shape so AnalysisTable renders them unchanged. UIDs
 * carry a `mk1:` prefix; setAnalysisResult / transitionAnalysis detect
 * the prefix and dispatch to Mk1 endpoints instead of the SENAITE proxy.
 */
export async function listLimsAnalysesForSubSample(
  subSamplePk: number
): Promise<SenaiteAnalysis[]> {
  const params = new URLSearchParams({
    host_kind: 'sub_sample',
    host_pk: String(subSamplePk),
    as: 'senaite_shape',
    include_retests: 'true',
  })
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`listLimsAnalysesForSubSample failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Phase senaite-writeback Task 4: provenance records written by promote.
 * One entry per keyword that has been promoted to the parent's SENAITE AR.
 */
export interface ParentPromotionInfo {
  keyword: string
  parent_analysis_id: number
  result_value?: string | null
  promoted_at: string
  promoted_by_email?: string | null
  sources: { sample_id?: string | null; contribution_kind: string }[]
}

/**
 * Fetch all promotion records for a parent sample.
 * GET /api/lims-analyses/promotions?parent_sample_id=<id>
 */
export async function listParentPromotions(
  parentSampleId: string
): Promise<ParentPromotionInfo[]> {
  const params = new URLSearchParams({ parent_sample_id: parentSampleId })
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses/promotions?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`listParentPromotions failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Fetch SENAITE analysis states for all lines on a parent AR, keyed by keyword.
 * Returns {"states": {"STER-PCR": "verified", ...}}.
 * The backend is best-effort: any SENAITE error returns {"states": {}}.
 * The frontend mirrors this: .catch(() => ({states: {}})).
 */
export async function listParentLineStates(
  parentSampleId: string
): Promise<{ states: Record<string, string> }> {
  const params = new URLSearchParams({ parent_sample_id: parentSampleId })
  const response = await fetch(`${API_BASE_URL()}/api/lims-analyses/parent-line-states?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    throw new Error(`listParentLineStates failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Create a new sub-sample for a parent sample.
 * May throw SecondaryFalloutError if SENAITE silently created an orphan AR.
 */
export async function createSubSample(args: {
  parentSampleId: string
  photoBase64: string
  remarks?: string
}): Promise<SubSample> {
  const response = await fetch(`${API_BASE_URL()}/api/sub-samples`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({
      parent_sample_id: args.parentSampleId,
      photo_base64: args.photoBase64,
      remarks: args.remarks ?? null,
    }),
  })

  if (!response.ok) {
    if (response.status === 502) {
      // Try to parse a structured fallout body
      try {
        const body = await response.json()
        const d = body?.detail
        if (d && typeof d === 'object' && d.code === 'secondary_fallout') {
          throw new SecondaryFalloutError(
            d.message ?? 'SENAITE silently created an orphan AR',
            d.orphan_uid,
            d.orphan_sample_id,
          )
        }
        throw new Error(
          `createSubSample failed: ${typeof d === 'string' ? d : JSON.stringify(d)}`
        )
      } catch (e) {
        if (e instanceof SecondaryFalloutError) throw e
        throw new Error(`createSubSample failed: ${response.status}`)
      }
    }
    throw new Error(`createSubSample failed: ${response.status}`)
  }

  return response.json()
}

export interface BulkSubSampleResult {
  created: SubSample[]
  requested: number
  failed: number
}

/**
 * Create N identical vials (same photo + remarks) for a parent in one call.
 * The photo is uploaded once; the server loops the single-create path. Created
 * vials carry assignment_role=NULL — refresh the vial-plan afterward to assign.
 * May throw SecondaryFalloutError if SENAITE silently created an orphan AR.
 */
export async function createSubSamplesBulk(args: {
  parentSampleId: string
  photoBase64: string
  count: number
  remarks?: string
}): Promise<BulkSubSampleResult> {
  const response = await fetch(`${API_BASE_URL()}/api/sub-samples/bulk`, {
    method: 'POST',
    headers: getBearerHeaders('application/json'),
    body: JSON.stringify({
      parent_sample_id: args.parentSampleId,
      photo_base64: args.photoBase64,
      count: args.count,
      remarks: args.remarks ?? null,
    }),
  })
  if (!response.ok) {
    if (response.status === 502) {
      try {
        const body = await response.json()
        const d = body?.detail
        if (d && typeof d === 'object' && d.code === 'secondary_fallout') {
          throw new SecondaryFalloutError(
            d.message ?? 'SENAITE silently created an orphan AR',
            d.orphan_uid,
            d.orphan_sample_id,
          )
        }
        throw new Error(
          `createSubSamplesBulk failed: ${typeof d === 'string' ? d : JSON.stringify(d)}`
        )
      } catch (e) {
        if (e instanceof SecondaryFalloutError) throw e
        throw new Error(`createSubSamplesBulk failed: ${response.status}`)
      }
    }
    throw new Error(`createSubSamplesBulk failed: ${response.status}`)
  }
  return response.json()
}

/**
 * Update a sub-sample (photo and/or remarks).
 */
export async function updateSubSample(
  sampleId: string,
  args: { photoBase64?: string; remarks?: string }
): Promise<SubSample> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        photo_base64: args.photoBase64 ?? null,
        remarks: args.remarks ?? null,
      }),
    }
  )
  if (!response.ok) throw new Error(`updateSubSample failed: ${response.status}`)
  return response.json()
}

/**
 * Delete a sub-sample.
 */
export async function deleteSubSample(sampleId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok && response.status !== 204)
    throw new Error(`deleteSubSample failed: ${response.status}`)
}

export interface VialDemandResponse {
  demand: { hplc: number; endo: number; ster: number }
  variance: { hplc: number; endo: number; ster: number }
  base_demand: { hplc: number; endo: number; ster: number }
  wp_order_number: string | null
  is_unreachable: boolean
}

/**
 * Get just the vial demand for a parent sample without running auto-assign.
 * Used by the wizard header for "expected vs received" counts on the capture step.
 */
export async function getVialDemand(parentSampleId: string): Promise<VialDemandResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/vial-demand`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Vial demand fetch failed: ${response.status}`)
  }
  return response.json()
}

export interface OrderBoxLabelSummary {
  order_number: string
  order_date: string | null
  counts: { hplc: number; endo: number; ster: number }
}

export async function getOrderBoxLabelSummary(
  orderNumber: string,
): Promise<OrderBoxLabelSummary> {
  return apiFetch<OrderBoxLabelSummary>(
    `/orders/${encodeURIComponent(orderNumber)}/box-label-summary`,
  )
}

export interface OrderBoxLabelSummaries {
  /** Keyed by the REQUESTED order number (absent = not found). */
  summaries: Record<string, OrderBoxLabelSummary>
  /** Orders whose IS services fetch failed (never silently undercounted). */
  errors: string[]
}

/** Batched box-label summaries — ONE call per receive-by-order page. The
 *  per-row endpoint above melted the backend DB pool when ~50 row cells fired
 *  concurrently under HTTP/2 (prod brownout 2026-07-09); never call it in a
 *  per-row loop. Max 100 order numbers per request. */
export async function getOrderBoxLabelSummaries(
  orderNumbers: string[],
): Promise<OrderBoxLabelSummaries> {
  return apiFetch<OrderBoxLabelSummaries>('/orders/box-label-summaries', {
    method: 'POST',
    body: JSON.stringify({ order_numbers: orderNumbers }),
  })
}

/**
 * Get the vial plan for a parent sample (demand, assignment roles, etc.).
 */
export async function getVialPlan(parentSampleId: string): Promise<VialPlanResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/vial-plan`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Vial plan fetch failed: ${response.status}`)
  }
  return response.json()
}

export interface ParentAggregate {
  /** Total vials = parent + sub-samples. Parents with no sub-samples
   *  are omitted from the response entirely (caller treats absence as
   *  "single-vial; render a dash"). */
  vial_count: number
  /** The parent AR's own assignment_role. Sub-sample roles are surfaced
   *  inline on expand via /api/sub-samples/{parent}, not here. */
  parent_role: 'hplc' | 'endo' | 'ster' | 'xtra' | 'unassigned'
  /** Per-bucket variance counts from the parent's variance_override (zeros when
   *  none). AR-list display hint; authoritative gate is server-side. Optional
   *  for back-compat with older responses. */
  variance?: { hplc: number; endo: number; ster: number }
  /** True when ≥1 sub-sample vial is assigned to the variance bucket
   *  (assignment_kind='variance'). Drives the parent list-row variance
   *  indicator independently of entitlement (`variance`). Optional for
   *  back-compat with older responses. */
  has_variance_subs?: boolean
}

export interface SampleAggregatesResponse {
  /** Keyed by parent sample_id. Sample IDs not in lims_samples are absent —
   *  callers treat absence as zero. */
  aggregates: Record<string, ParentAggregate>
}

/**
 * Batch fetch sub-sample count + role breakdown for a list of parent sample IDs.
 * Used by the SENAITE samples list to render the Vials and Assigned columns.
 */
export async function fetchSampleAggregates(
  parentSampleIds: string[]
): Promise<SampleAggregatesResponse> {
  if (parentSampleIds.length === 0) {
    return { aggregates: {} }
  }
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/aggregates`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ parent_sample_ids: parentSampleIds }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `Sample aggregates fetch failed: ${response.status}`)
  }
  return response.json()
}

/** API error carrying the structured `detail.code` from a non-2xx response
 *  (e.g. 'variance_locked' on a 409 from PATCH /assignment). Callers branch
 *  on `code`, never on message text. */
export class ApiCodeError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'ApiCodeError'
    this.code = code
  }
}

/**
 * Update the assignment role (and optional kind) for a sub-sample.
 * @param kind - 'core' | 'variance' | null — omit (undefined) for reset/null calls
 *   where kind is irrelevant. The server treats absent kind as null.
 * @throws ApiCodeError with code='variance_locked' when the parent's variance
 *   set is locked (409).
 */
export async function patchVialAssignment(
  sampleId: string,
  role: AssignmentRole | null,
  kind?: 'core' | 'variance' | null,
): Promise<{ sample_id: string; assignment_role: AssignmentRole | null }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/assignment`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ role, kind: kind ?? null }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    const message =
      typeof detail === 'object' && detail?.message
        ? detail.message
        : typeof detail === 'string'
        ? detail
        : `Vial assignment update failed: ${response.status}`
    const code = typeof detail === 'object' ? detail?.code ?? null : null
    throw new ApiCodeError(message, code)
  }
  return response.json()
}

export interface LimsBox {
  id: number
  order_key: string
  box_number: number
  role: 'hplc' | 'endo' | 'ster' | 'xtra'
  label_code: string
  vial_count: number
  printed_at: string | null
  created_at: string | null
  stored_at: string | null
  vials?: {
    sample_id: string
    parent_sample_id: string | null
    assignment_role: string | null
    vial_sequence: number
  }[]
}

export async function listOrderBoxes(orderKey: string): Promise<LimsBox[]> {
  return apiFetch<LimsBox[]>(`/api/boxes?order_key=${encodeURIComponent(orderKey)}`)
}

export async function createBox(
  orderKey: string,
  role: 'hplc' | 'endo' | 'ster' | 'xtra',
): Promise<LimsBox> {
  return apiFetch<LimsBox>('/api/boxes', {
    method: 'POST',
    body: JSON.stringify({ order_key: orderKey, role }),
  })
}

export async function assignVialsToBox(
  boxId: number,
  subSampleIds: string[],
): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ sub_sample_ids: subSampleIds }),
  })
}

/** Clear box membership for the given vials (drag back out to the Unboxed
 *  tray). Mirrors {@link assignVialsToBox}; backend responds `{ unassigned: N }`. */
export async function unassignVialsFromBox(subSampleIds: string[]): Promise<void> {
  await apiFetch<{ unassigned: number }>('/api/boxes/unassign', {
    method: 'POST',
    body: JSON.stringify({ sub_sample_ids: subSampleIds }),
  })
}

export async function printBox(boxId: number): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/print`, { method: 'POST' })
}

/** Delete a box outright (mistake path): its vials return to Unboxed. */
export async function deleteBox(boxId: number): Promise<void> {
  await apiFetch<void>(`/api/boxes/${boxId}`, { method: 'DELETE' })
}

/** All boxes not yet closed out to storage, across all orders. */
export async function listActiveBoxes(): Promise<LimsBox[]> {
  return apiFetch<LimsBox[]>('/api/boxes/active')
}

/** Close out a box (end-of-life): vials return to Unboxed, box is stamped
 *  stored and drops off active surfaces. Idempotent on the backend. */
export async function closeBox(boxId: number): Promise<LimsBox> {
  return apiFetch<LimsBox>(`/api/boxes/${boxId}/close`, { method: 'POST' })
}

/** Per-service variance counts the parent's order purchased. Empty when none
 *  or unreachable — callers fail closed (action hidden). */
export async function fetchVarianceEntitlement(
  parentSampleId: string,
): Promise<{ variance: Record<string, number>; unreachable: boolean }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-entitlement`,
    { headers: getBearerHeaders() },
  )
  if (!response.ok) {
    return { variance: {}, unreachable: true }
  }
  return response.json()
}

/** Set/clear the lab-side variance override (interim until the WP addon). */
export async function putVarianceOverride(
  parentSampleId: string,
  variance: Record<string, number> | null,
): Promise<{ variance: Record<string, number> }> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-override`,
    {
      method: 'PUT',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ variance }),
    },
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      typeof err?.detail === 'string'
        ? err.detail
        : err?.detail?.message || `Variance override failed: ${response.status}`,
    )
  }
  return response.json()
}

/**
 * Resolve a renderable object URL for a sub-sample's most-recent photo.
 * The backend proxy requires Bearer auth, so a plain `<img src=...>` would
 * 401; we have to fetch as blob and wrap it in an object URL. Mirrors
 * fetchSenaiteAttachmentUrl. Returns null if no photo is on file (404).
 */
const _subSamplePhotoCache = new Map<string, string>()

/**
 * Prime the photo cache with a just-captured image so the thumbnail renders
 * instantly, without round-tripping the photo endpoint.
 *
 * The first vial's photo is stored on the parent AR in SENAITE, whose
 * attachment listing has a read-after-write window — a fetch fired the instant
 * the parent row appears can miss it, and the thumbnail components fetch once
 * with no retry. Seeding the cache at save time sidesteps that race entirely:
 * the bytes are the exact photo the user just took. (`<img>` content-sniffs the
 * blob, so the declared type need only be a plausible image type.) Sub-sample
 * photos read from Mk1 disk immediately and don't need this, but seeding them
 * too is harmless and saves a round-trip.
 */
export function seedSubSamplePhoto(sampleId: string, bytes: Uint8Array): void {
  const prev = _subSamplePhotoCache.get(sampleId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  // Copy into a fresh ArrayBuffer so the Blob part is unambiguously typed.
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const blob = new Blob([buf], { type: 'image/jpeg' })
  _subSamplePhotoCache.set(sampleId, URL.createObjectURL(blob))
}

export async function fetchSubSamplePhotoUrl(
  sampleId: string
): Promise<string | null> {
  const cached = _subSamplePhotoCache.get(sampleId)
  if (cached) return cached

  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/photo`,
    { headers: getBearerHeaders() }
  )
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`fetchSubSamplePhotoUrl failed: ${response.status}`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  _subSamplePhotoCache.set(sampleId, url)
  return url
}

/**
 * Drop a sample's cached photo object URL so the next fetch hits the server.
 * Call after the photo is replaced or removed.
 */
export function invalidateSubSamplePhoto(sampleId: string): void {
  const prev = _subSamplePhotoCache.get(sampleId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _subSamplePhotoCache.delete(sampleId)
}

/**
 * Remove a vial's check-in photo (Mk1-stored only; legacy SENAITE photos 409).
 * Invalidates the local photo cache on success.
 */
export async function deleteSubSamplePhoto(sampleId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/photo`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok && response.status !== 204)
    throw new Error(`deleteSubSamplePhoto failed: ${response.status}`)
  invalidateSubSamplePhoto(sampleId)
}

// ── Sub-sample chromatograms (vial-scoped prep linkage) ───────────────────────

export interface SubSampleChromatogram {
  analysis_id: number
  vial_sample_id: string
  vial_sequence: number
  assignment_role: string | null
  assignment_kind: string | null
  peptide_abbreviation: string | null
  prep_id: number
  created_at: string | null
  /** Raw series (~800 LTTB points) for in-app recharts rendering. */
  data: { times: number[]; signals: number[] }
}

/**
 * Chromatogram candidates from vial-scoped sample preps. A vial id returns
 * its own; a parent id returns candidates across the whole family (newest
 * first). Render with renderChromatogramImage(analysis_id); push to the
 * parent AR with uploadChromatogramToSenaite(analysis_id, parentUid).
 */
export async function listSubSampleChromatograms(
  sampleId: string
): Promise<SubSampleChromatogram[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/chromatograms`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok)
    throw new Error(`listSubSampleChromatograms failed: ${response.status}`)
  const body = await response.json()
  return body.chromatograms ?? []
}

// ── Sub-sample image attachments (2026-06-11 design) ──────────────────────────

export interface SubSampleAttachment {
  id: number
  filename: string
  content_type: string
  created_at: string
  /** Uploader display name; populated by the LIST endpoint. */
  created_by?: string | null
}

export async function listSubSampleAttachments(
  sampleId: string
): Promise<SubSampleAttachment[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/attachments`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok)
    throw new Error(`listSubSampleAttachments failed: ${response.status}`)
  const body = await response.json()
  return body.attachments ?? []
}

export async function uploadSubSampleAttachment(
  sampleId: string,
  imageBase64: string,
  filename: string
): Promise<SubSampleAttachment> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/attachments`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({ image_base64: imageBase64, filename }),
    }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(
      typeof err?.detail === 'string'
        ? err.detail
        : `uploadSubSampleAttachment failed: ${response.status}`
    )
  }
  return response.json()
}

/**
 * Object URL for an attachment's image (Bearer-authed proxy, same pattern as
 * fetchSubSamplePhotoUrl). Cached per attachment id.
 */
const _subSampleAttachmentCache = new Map<number, string>()

export async function fetchSubSampleAttachmentUrl(
  sampleId: string,
  attachmentId: number
): Promise<string | null> {
  const cached = _subSampleAttachmentCache.get(attachmentId)
  if (cached) return cached
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/attachments/${attachmentId}`,
    { headers: getBearerHeaders() }
  )
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`fetchSubSampleAttachmentUrl failed: ${response.status}`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  _subSampleAttachmentCache.set(attachmentId, url)
  return url
}

/**
 * Promote an extra image to be the vial's primary (check-in) photo. The
 * previous Mk1-stored photo is demoted to a regular attachment server-side.
 * Invalidates the photo cache and the promoted attachment's object URL
 * (its row is consumed by the photo slot).
 */
export async function setSubSamplePrimaryAttachment(
  sampleId: string,
  attachmentId: number
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/attachments/${attachmentId}/make-primary`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    const detail = err?.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : detail?.message ?? `setSubSamplePrimaryAttachment failed: ${response.status}`
    )
  }
  invalidateSubSamplePhoto(sampleId)
  const prev = _subSampleAttachmentCache.get(attachmentId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _subSampleAttachmentCache.delete(attachmentId)
}

export async function deleteSubSampleAttachment(
  sampleId: string,
  attachmentId: number
): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/attachments/${attachmentId}`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok && response.status !== 204)
    throw new Error(`deleteSubSampleAttachment failed: ${response.status}`)
  const prev = _subSampleAttachmentCache.get(attachmentId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _subSampleAttachmentCache.delete(attachmentId)
}

// ── Variance set (worksheet-variance design 2026-06-02) ──────────────────────

export interface VarianceResultEntry {
  value: number | string | null
  kind: 'numeric' | 'categorical'
  spec?: Record<string, number> | null
  // Phase 4b: present for Mk1-sourced results (uid='mk1:<N>'). null for
  // legacy SENAITE-sourced rows since only Mk1 vial-tier rows can be
  // promoted. promoted_to_parent_id is set once a successful promote has
  // landed for this source.
  uid?: string | null
  promoted_to_parent_id?: number | null
}

export interface VarianceVial {
  sample_id: string
  vial_sequence: number
  is_parent: boolean
  in_variance_set: boolean
  exclusion_reason: string | null
  review_state: string | null
  results: Record<string, VarianceResultEntry>
}

export interface VarianceStatsEntry {
  kind: 'numeric' | 'categorical'
  mean: number | null
  sd: number | null
  cv_pct: number | null
  n: number
  conforms_count?: number | null
  total?: number | null
  spec: Record<string, number> | null
  pass: boolean | null
}

export interface VarianceSetResponse {
  parent: ParentSampleSummary
  vials: VarianceVial[]
  stats: Record<string, VarianceStatsEntry>
  locked: boolean
  locked_at: string | null
  locked_by_user_id: number | null
}

export async function getVarianceSet(parentSampleId: string): Promise<VarianceSetResponse> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set`,
    { headers: getBearerHeaders() }
  )
  if (!r.ok) throw new Error(`getVarianceSet failed: ${r.status}`)
  return r.json()
}

export async function patchVarianceMembership(args: {
  sampleId: string
  inVarianceSet: boolean
  exclusionReason?: string | null
}): Promise<{ sample_id: string; in_variance_set: boolean; exclusion_reason: string | null }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(args.sampleId)}/variance-set`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        in_variance_set: args.inVarianceSet,
        exclusion_reason: args.exclusionReason ?? null,
      }),
    }
  )
  if (r.status === 409) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.detail?.message ?? 'variance set is locked')
  }
  if (!r.ok) throw new Error(`patchVarianceMembership failed: ${r.status}`)
  return r.json()
}

export async function lockVarianceSet(parentSampleId: string): Promise<{ parent_sample_id: string; locked_at: string }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set/lock`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (r.status === 422) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.detail?.message ?? 'need >=2 selected vials to lock')
  }
  if (!r.ok) throw new Error(`lockVarianceSet failed: ${r.status}`)
  return r.json()
}

export async function unlockVarianceSet(parentSampleId: string): Promise<{ parent_sample_id: string; locked: boolean }> {
  const r = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(parentSampleId)}/variance-set/unlock`,
    { method: 'POST', headers: getBearerHeaders() }
  )
  if (r.status === 403) throw new Error('admin role required to unlock variance sets')
  if (!r.ok) throw new Error(`unlockVarianceSet failed: ${r.status}`)
  return r.json()
}

// ─── Ordered Products ──────────────────────────────────────────────────────

export interface OrderedProduct {
  key: string
  label: string
  is_addon: boolean
  fulfillment_role: string | null
  fulfillment_dim: 'role' | 'kind'
}

export interface OrderedProductsResponse {
  sample_id: string
  wp_order_number: string | null
  products: OrderedProduct[]
}

export class OrderedProductsError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    super(`ordered-products failed: ${status}`)
    this.name = 'OrderedProductsError'
    this.status = status
    this.detail = detail
  }
}

export async function getOrderedProducts(sampleId: string): Promise<OrderedProductsResponse> {
  const response = await fetch(
    `${API_BASE_URL()}/api/sub-samples/${encodeURIComponent(sampleId)}/ordered-products`,
    { headers: getBearerHeaders() },
  )
  if (!response.ok) {
    let detail: unknown = null
    try { detail = (await response.json()).detail ?? null } catch { /* no body */ }
    throw new OrderedProductsError(response.status, detail)
  }
  return response.json()
}

// ── Packaging photos (Mk1-native, stored in S3-gated PhotoStorage) ──────────

export interface PackagingPhoto {
  id: number
  ordering: number
  remarks: string | null
  content_type: string | null
  created_at: string
  created_by_user_id: number | null
  /** Uploader display name; populated by the LIST endpoint. */
  created_by?: string | null
}

/**
 * Create a packaging photo against a parent sample. Mirrors createSubSample's
 * headers/base-URL/error handling.
 */
export async function createPackagingPhoto(args: {
  parentSampleId: string
  photoBase64: string
  remarks?: string | null
  filename?: string
  contentType?: string
}): Promise<PackagingPhoto> {
  const response = await fetch(
    `${API_BASE_URL()}/api/samples/${encodeURIComponent(args.parentSampleId)}/packaging-photos`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        photo_base64: args.photoBase64,
        remarks: args.remarks ?? null,
        filename: args.filename ?? null,
        content_type: args.contentType ?? null,
      }),
    }
  )
  if (!response.ok)
    throw new Error(`createPackagingPhoto failed: ${response.status}`)
  return response.json()
}

/**
 * List a parent sample's packaging photos (ordered by `ordering`).
 */
export async function listPackagingPhotos(
  parentSampleId: string
): Promise<PackagingPhoto[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/samples/${encodeURIComponent(parentSampleId)}/packaging-photos`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok)
    throw new Error(`listPackagingPhotos failed: ${response.status}`)
  return response.json()
}

/**
 * Resolve a renderable object URL for a packaging photo's raw bytes. The
 * backend requires Bearer auth, so a plain `<img src=...>` would 401; we fetch
 * as blob and wrap it in an object URL. Mirrors fetchSubSamplePhotoUrl.
 * Returns null if the photo is missing (404). Cached per photoId.
 */
const _packagingPhotoCache = new Map<number, string>()

export async function fetchPackagingPhotoUrl(
  photoId: number
): Promise<string | null> {
  const cached = _packagingPhotoCache.get(photoId)
  if (cached) return cached

  const response = await fetch(
    `${API_BASE_URL()}/api/packaging-photos/${photoId}`,
    { headers: getBearerHeaders() }
  )
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`fetchPackagingPhotoUrl failed: ${response.status}`)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  _packagingPhotoCache.set(photoId, url)
  return url
}

/**
 * Drop a packaging photo's cached object URL so the next fetch hits the server.
 * Call after the photo is replaced or removed.
 */
export function invalidatePackagingPhoto(photoId: number): void {
  const prev = _packagingPhotoCache.get(photoId)
  if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
  _packagingPhotoCache.delete(photoId)
}

/**
 * Update a packaging photo (bytes and/or remarks). Mirrors updateSubSample.
 */
export async function updatePackagingPhoto(
  photoId: number,
  args: { photoBase64?: string; remarks?: string | null }
): Promise<PackagingPhoto> {
  const response = await fetch(
    `${API_BASE_URL()}/api/packaging-photos/${photoId}`,
    {
      method: 'PATCH',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        photo_base64: args.photoBase64 ?? null,
        remarks: args.remarks ?? null,
      }),
    }
  )
  if (!response.ok)
    throw new Error(`updatePackagingPhoto failed: ${response.status}`)
  if (args.photoBase64) invalidatePackagingPhoto(photoId)
  return response.json()
}

/**
 * Delete a packaging photo. Invalidates the local blob cache on success.
 */
export async function deletePackagingPhoto(photoId: number): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL()}/api/packaging-photos/${photoId}`,
    { method: 'DELETE', headers: getBearerHeaders() }
  )
  if (!response.ok && response.status !== 204)
    throw new Error(`deletePackagingPhoto failed: ${response.status}`)
  invalidatePackagingPhoto(photoId)
}

/**
 * Create the same packaging photo against every parent sample in an order in
 * one transactional call. Mirrors createPackagingPhoto's headers/base-URL/
 * error handling.
 */
export async function createPackagingPhotosBulk(args: {
  parentSampleIds: string[]
  photoBase64: string
  remarks?: string | null
}): Promise<PackagingPhoto[]> {
  const response = await fetch(
    `${API_BASE_URL()}/api/packaging-photos/bulk`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        parent_sample_ids: args.parentSampleIds,
        photo_base64: args.photoBase64,
        remarks: args.remarks ?? null,
      }),
    }
  )
  if (!response.ok)
    throw new Error(`createPackagingPhotosBulk failed: ${response.status}`)
  return response.json()
}

// ── Capture tokens (QR phone capture) ───────────────────────────────────────

export interface CaptureSampleContext {
  sample_id: string
  lot?: string | null
  analytes?: string | null
}

export interface CaptureTokenMint {
  id: number
  token: string
  expires_at: string
}

/**
 * Mint a scoped, time-limited capture token so a phone can add packaging
 * photos without logging in. Mirrors createPackagingPhoto's headers/base-URL/
 * error handling.
 */
export async function mintCaptureToken(args: {
  samples: CaptureSampleContext[]
  orderLabel?: string | null
}): Promise<CaptureTokenMint> {
  const response = await fetch(
    `${API_BASE_URL()}/api/capture-tokens`,
    {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify({
        samples: args.samples,
        order_label: args.orderLabel ?? null,
      }),
    }
  )
  if (!response.ok)
    throw new Error(`mintCaptureToken failed: ${response.status}`)
  return response.json()
}
