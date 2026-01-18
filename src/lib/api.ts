/**
 * API client for communicating with the FastAPI backend.
 */

import { API_BASE_URL } from './config'

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
 */
export async function healthCheck(): Promise<HealthResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`)
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Health check error:', error)
    throw error
  }
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
    const response = await fetch(`${API_BASE_URL}/audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
    const response = await fetch(`${API_BASE_URL}/audit?limit=${limit}`)
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
    const response = await fetch(`${API_BASE_URL}/settings`)
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
    const response = await fetch(`${API_BASE_URL}/settings/${encodeURIComponent(key)}`)
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
export async function updateSetting(key: string, value: string): Promise<Setting> {
  try {
    const response = await fetch(`${API_BASE_URL}/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value }),
    })
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
export async function updateColumnMappings(mappings: ColumnMappings): Promise<Setting> {
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
      `${API_BASE_URL}/import/file?file_path=${encodeURIComponent(filePath)}`,
      {
        method: 'POST',
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
    const response = await fetch(`${API_BASE_URL}/import/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
export async function importBatchData(files: FileData[]): Promise<ImportResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/import/batch-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
    const response = await fetch(`${API_BASE_URL}/jobs?limit=${limit}`)
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
    const response = await fetch(`${API_BASE_URL}/jobs/${jobId}`)
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
    const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/samples`)
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
export async function getSamplesWithResults(jobId: number): Promise<SampleWithResults[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/samples-with-results`)
    if (!response.ok) {
      throw new Error(`Get job ${jobId} samples with results failed: ${response.status}`)
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
    const response = await fetch(`${API_BASE_URL}/samples?limit=${limit}`)
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
    const response = await fetch(`${API_BASE_URL}/samples/${sampleId}`)
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
    const response = await fetch(`${API_BASE_URL}/samples/${sampleId}/approve`, {
      method: 'PUT',
    })
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
export async function rejectSample(sampleId: number, reason: string): Promise<Sample> {
  try {
    const response = await fetch(`${API_BASE_URL}/samples/${sampleId}/reject`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason }),
    })
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
export async function calculateSample(sampleId: number): Promise<CalculationSummary> {
  try {
    const response = await fetch(`${API_BASE_URL}/calculate/${sampleId}`, {
      method: 'POST',
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
    const response = await fetch(`${API_BASE_URL}/calculations/types`)
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
    const response = await fetch(`${API_BASE_URL}/calculate/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
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
export async function getSampleResults(sampleId: number): Promise<StoredResult[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/samples/${sampleId}/results`)
    if (!response.ok) {
      throw new Error(`Get sample ${sampleId} results failed: ${response.status}`)
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
    const response = await fetch(`${API_BASE_URL}/watcher/status`)
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
export async function startWatcher(): Promise<{ status: string; watching: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/watcher/start`, { method: 'POST' })
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
    const response = await fetch(`${API_BASE_URL}/watcher/stop`, { method: 'POST' })
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
    const response = await fetch(`${API_BASE_URL}/watcher/files`)
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
 * Check connection to Integration Service database.
 */
export async function getExplorerStatus(): Promise<ExplorerConnectionStatus> {
  try {
    const response = await fetch(`${API_BASE_URL}/explorer/status`)
    if (!response.ok) {
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
    const response = await fetch(`${API_BASE_URL}/explorer/environments`)
    if (!response.ok) {
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
    const response = await fetch(`${API_BASE_URL}/explorer/environments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environment }),
    })
    if (!response.ok) {
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
 */
export async function getExplorerOrders(
  search?: string,
  limit = 50,
  offset = 0
): Promise<ExplorerOrder[]> {
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    const response = await fetch(`${API_BASE_URL}/explorer/orders?${params}`)
    if (!response.ok) {
      throw new Error(`Get explorer orders failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error('Get explorer orders error:', error)
    throw error
  }
}

/**
 * Get all ingestions for an order from Integration Service database.
 *
 * @param orderId - The WordPress order ID (e.g., "12345")
 */
export async function getOrderIngestions(orderId: string): Promise<ExplorerIngestion[]> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/explorer/orders/${encodeURIComponent(orderId)}/ingestions`
    )
    if (!response.ok) {
      throw new Error(`Get order ${orderId} ingestions failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    console.error(`Get order ${orderId} ingestions error:`, error)
    throw error
  }
}

