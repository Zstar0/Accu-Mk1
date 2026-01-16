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
 */
export interface Sample {
  id: number
  job_id: number
  filename: string
  status: string
  input_data: {
    rows: Record<string, string | number | null>[]
    headers: string[]
    row_count: number
  } | null
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
