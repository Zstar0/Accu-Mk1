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
  status: string
  samples_expected: number
  samples_delivered: number
  error_message: string | null
  payload: Record<string, unknown> | null
  sample_results: Record<string, { senaite_id: string; status: string }> | null
  created_at: string
  updated_at: string
  completed_at: string | null
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
  published_at: string | null
  superseded_at: string | null
  created_at: string
  order_id: string | null
  order_number: string | null
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

export interface HPLCParseResult {
  injections: HPLCInjection[]
  purity: HPLCPurity
  errors: string[]
  detected_peptides: string[]
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
  slope: number
  intercept: number
  r_squared: number
  standard_data: { concentrations: number[]; areas: number[] } | null
  source_filename: string | null
  source_path: string | null
  source_date: string | null
  sharepoint_url: string | null
  is_active: boolean
  created_at: string
  // Standard identification metadata
  instrument: string | null
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
}

export interface InstrumentSummary {
  instrument: string // "1260", "1290", or "unknown"
  curve_count: number
}

export interface PeptideRecord {
  id: number
  name: string
  abbreviation: string
  reference_rt: number | null
  rt_tolerance: number
  diluent_density: number
  active: boolean
  created_at: string
  updated_at: string
  active_calibration: CalibrationCurve | null
  calibration_summary: InstrumentSummary[]
}

export interface PeptideCreateInput {
  name: string
  abbreviation: string
  reference_rt?: number | null
  rt_tolerance?: number
  diluent_density?: number
}

export interface CalibrationDataInput {
  concentrations: number[]
  areas: number[]
  source_filename?: string
}

export async function getPeptides(): Promise<PeptideRecord[]> {
  try {
    const response = await fetch(`${API_BASE_URL()}/peptides`, {
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
  data: Partial<PeptideCreateInput & { active: boolean }>
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
  created_at: string
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
  is_current: boolean
  recorded_at: string
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
  calculations: Record<string, number> | null
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
}): Promise<WizardSessionResponse> {
  try {
    const response = await fetch(`${API_BASE_URL()}/wizard/sessions`, {
      method: 'POST',
      headers: getBearerHeaders('application/json'),
      body: JSON.stringify(data),
    })
    if (!response.ok) {
      throw new Error(`Create wizard session failed: ${response.status}`)
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
  data: { step_key: string; weight_mg: number; source: string }
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

// --- SENAITE Lookup API ---

export interface SenaiteAnalyte {
  raw_name: string
  matched_peptide_id: number | null
  matched_peptide_name: string | null
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

export interface SenaiteAnalysis {
  title: string
  result: string | null
  unit: string | null
  method: string | null
  instrument: string | null
  analyst: string | null
  due_date: string | null
  review_state: string | null
  sort_key: number | null
  captured: string | null
  retested: boolean
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
  senaite_url: string | null
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

export async function lookupSenaiteSample(
  sampleId: string
): Promise<SenaiteLookupResult> {
  const response = await fetch(
    `${API_BASE_URL()}/wizard/senaite/lookup?id=${encodeURIComponent(sampleId)}`,
    { headers: getBearerHeaders() }
  )
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE lookup failed: ${response.status}`)
  }
  return response.json()
}

export interface SenaiteSample {
  uid: string
  id: string
  title: string
  client_id: string | null
  client_order_number: string | null
  date_received: string | null
  date_sampled: string | null
  review_state: string
  sample_type: string | null
  contact: string | null
}

export interface SenaiteSamplesResponse {
  items: SenaiteSample[]
  total: number
  b_start: number
}

export async function getSenaiteSamples(
  reviewState?: string,
  limit = 50,
  bStart = 0
): Promise<SenaiteSamplesResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    b_start: String(bStart),
  })
  if (reviewState) params.set('review_state', reviewState)
  const response = await fetch(`${API_BASE_URL()}/senaite/samples?${params}`, {
    headers: getBearerHeaders(),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => null)
    throw new Error(err?.detail || `SENAITE samples failed: ${response.status}`)
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
