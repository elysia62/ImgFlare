/** Same-origin API client for the authenticated panel. */

import type {
  ApiToken,
  BackupStatus,
  CreatedToken,
  DuplicateCheckResult,
  FileListResponse,
  FileInfo,
  MeResponse,
  UploadResult,
} from '../../shared/types.js';

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

}

/** Perform a request and unwrap the `{ success, data }` envelope. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(path === '/api/backup/run' ? 120_000 : 15_000)]) : AbortSignal.timeout(path === '/api/backup/run' ? 120_000 : 15_000),
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network_error', 0);
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!isObject(payload)) throw new ApiError('invalid_response', response.status);
  if (!response.ok || payload.success === false) {
    throw new ApiError(typeof payload.error === 'string' ? payload.error : 'http_error', response.status);
  }
  if (payload.success !== true) throw new ApiError('invalid_response', response.status);
  return ('data' in payload ? payload.data : payload) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFile(value: unknown): value is FileInfo {
  return isObject(value) && ['id','sha256','name','contentType','url','markdown'].every((key) => typeof value[key] === 'string')
    && typeof value.size === 'number' && typeof value.createdAt === 'number'
    && (value.thumbnailUrl === null || typeof value.thumbnailUrl === 'string');
}

export function parseUploadResult(value: unknown, status: number): UploadResult {
  if (!isObject(value)) throw new ApiError('invalid_response', status);
  if (status < 200 || status >= 300 || value.success === false) {
    throw new ApiError(typeof value.error === 'string' ? value.error : 'upload_failed', status);
  }
  if (value.success !== true || typeof value.deduplicated !== 'boolean' || !isFile(value.file)) {
    throw new ApiError('invalid_response', status);
  }
  return { success: true, deduplicated: value.deduplicated, file: value.file };
}

// Auth

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

// Upload

export function checkDuplicate(
  sha256: string,
): Promise<DuplicateCheckResult> {
  return request<DuplicateCheckResult>('/api/upload/check', {
    method: 'POST',
    body: JSON.stringify({ sha256 }),
  });
}

/** Multipart upload with progress reporting. */
export async function uploadFile(
  file: File,
  sha256: string,
  onProgress?: (fraction: number) => void,
  thumbnail?: File | null,
): Promise<UploadResult> {
  const form = new FormData();
  // The filename travels inside the multipart body, which is the only place
  // the server reads it from. Do NOT mirror it into a header: HTTP header
  // values are restricted to ISO-8859-1, so a Chinese filename would either
  // be mangled or throw a SyntaxError at setRequestHeader().
  form.append('file', file, file.name);
  if (thumbnail) form.append('thumbnail', thumbnail, thumbnail.name);

  // Use XHR rather than fetch: it is still the only way to observe upload
  // progress for a multipart body.
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.withCredentials = true;
    xhr.timeout = 120_000;
    xhr.setRequestHeader('X-File-SHA256', sha256);
    xhr.setRequestHeader('Accept', 'application/json');

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      });
    }

    xhr.addEventListener('timeout', () => reject(new ApiError('timeout', 0)));
    xhr.addEventListener('error', () => reject(new ApiError('network_error', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError('aborted', 0)));

    xhr.addEventListener('load', () => {
      try { resolve(parseUploadResult(JSON.parse(xhr.responseText) as unknown, xhr.status)); }
      catch (error) { reject(error instanceof ApiError ? error : new ApiError('invalid_response', xhr.status)); }
    });

    xhr.send(form);
  });
}

// Files

export function listFiles(options: {
  q?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<FileListResponse> {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return request<FileListResponse>(`/api/files${query ? `?${query}` : ''}`, { signal: options.signal });
}

export function deleteFile(id: string): Promise<void> {
  return request<void>(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// Tokens

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

// Backup

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

export function saveThumbnail(id: string, file: File): Promise<FileInfo> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request(`/api/files/${encodeURIComponent(id)}/thumbnail`, { method: 'POST', body: form });
}
