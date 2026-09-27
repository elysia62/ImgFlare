/**
 * Thin API client.
 *
 * Everything is same-origin and cookie-authenticated, so `credentials:
 * "same-origin"` is all that is needed — there is no CORS handling anywhere on
 * the server, by design.
 */

import type {
  ApiResponse,
  ApiToken,
  BackupStatus,
  CreatedToken,
  DuplicateCheckResult,
  FileInfo,
  FileListResponse,
  MeResponse,
  StatsResponse,
  UploadResult,
} from './types.js';

/** Raised when the server answers with `success: false`. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** The session is gone — the caller should bounce to the login page. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Perform a request and unwrap the `{ success, data }` envelope. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  // 204 and other bodyless responses.
  if (response.status === 204) {
    return undefined as T;
  }

  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    // Non-JSON body — fall through to a generic error below.
  }

  if (!response.ok) {
    throw new ApiError(payload?.error ?? 'http_error', response.status);
  }
  if (payload && payload.success === false) {
    throw new ApiError(payload.error ?? 'unknown_error', response.status);
  }

  return (payload?.data ?? (payload as unknown)) as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function login(
  username: string,
  password: string,
  turnstileToken: string,
): Promise<void> {
  return request<void>('/api/login', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      'cf-turnstile-response': turnstileToken,
    }),
  });
}

export function logout(): Promise<void> {
  return request<void>('/api/logout', { method: 'POST' });
}

export function me(): Promise<MeResponse> {
  return request<MeResponse>('/api/me');
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export function checkDuplicate(
  sha256: string,
  size: number,
): Promise<DuplicateCheckResult> {
  return request<DuplicateCheckResult>('/api/upload/check', {
    method: 'POST',
    body: JSON.stringify({ sha256, size }),
  });
}

/**
 * Upload a single file.
 *
 * The hash travels in `X-File-SHA256` so the worker can enforce it as an R2
 * checksum. `X-File-Name` carries the original name; the multipart filename is
 * set to the same value but browsers mangle non-ASCII names, so the header is
 * the reliable copy.
 */
export async function uploadFile(
  file: File,
  sha256: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const form = new FormData();
  // The filename travels inside the multipart body, which is the only place
  // the server reads it from. Do NOT mirror it into a header: HTTP header
  // values are restricted to ISO-8859-1, so a Chinese filename would either
  // be mangled or throw a SyntaxError at setRequestHeader().
  form.append('file', file, file.name);

  // Use XHR rather than fetch: it is still the only way to observe upload
  // progress for a multipart body.
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-File-SHA256', sha256);
    xhr.setRequestHeader('Accept', 'application/json');

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      });
    }

    xhr.addEventListener('error', () => reject(new ApiError('network_error', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('aborted', 0)));

    xhr.addEventListener('load', () => {
      let payload: ApiResponse<UploadResult> | null = null;
      try {
        payload = JSON.parse(xhr.responseText) as ApiResponse<UploadResult>;
      } catch {
        reject(new ApiError('invalid_response', xhr.status));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload.success !== false) {
        resolve(payload as unknown as UploadResult);
      } else {
        reject(new ApiError(payload?.error ?? 'upload_failed', xhr.status));
      }
    });

    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function listFiles(options: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<FileListResponse> {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));

  const query = params.toString();
  return request<FileListResponse>(`/api/files${query ? `?${query}` : ''}`);
}

export function getFile(id: string): Promise<FileInfo> {
  return request<FileInfo>(`/api/files/${encodeURIComponent(id)}`);
}

export function deleteFile(id: string): Promise<void> {
  return request<void>(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function stats(): Promise<StatsResponse> {
  return request<StatsResponse>('/api/stats');
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function listTokens(): Promise<ApiToken[]> {
  return request<ApiToken[]>('/api/tokens');
}

export function createToken(name: string): Promise<CreatedToken> {
  return request<CreatedToken>('/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function revokeToken(id: string): Promise<void> {
  return request<void>(`/api/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export function backupStatus(): Promise<BackupStatus> {
  return request<BackupStatus>('/api/backup/status');
}

/** Trigger a backup immediately — useful for verifying cron without waiting. */
export function runBackup(): Promise<{
  bytes: number;
  sha256: string;
  finished_at: number;
}> {
  return request('/api/backup/run', { method: 'POST' });
}

/** The download link is a plain navigation so the browser handles the file. */
export const BACKUP_DOWNLOAD_URL = '/api/backup/latest';
