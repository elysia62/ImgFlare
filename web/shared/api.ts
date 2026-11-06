import type { DuplicateCheckResult, FileInfo, UploadResult } from './types.js';

/** API failures retain the HTTP status so callers can decide whether to retry. */
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

/** Validate the envelope before unwrapping either API response shape. */
export function parseResponse(payload: unknown, status: number): unknown {
  if (!isObject(payload)) throw new ApiError('invalid_response', status);
  if (status < 200 || status >= 300 || payload.success === false) {
    throw new ApiError(typeof payload.error === 'string' ? payload.error : 'http_error', status);
  }
  if (payload.success !== true) throw new ApiError('invalid_response', status);
  return 'data' in payload ? payload.data : payload;
}

export function parseDuplicateResult(value: unknown): DuplicateCheckResult {
  if (!isObject(value) || value.success !== true || typeof value.exists !== 'boolean'
    || (value.file == null ? value.exists : !isFile(value.file))) {
    throw new ApiError('invalid_response', 200);
  }
  return value as unknown as DuplicateCheckResult;
}
