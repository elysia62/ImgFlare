/** API types shared by the panel and userscript. */

/** A stored file, as returned by every file-related endpoint. */
export interface FileInfo {
  id: string;
  sha256: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
  markdown: string;
  createdAt: number;
  thumbnailUrl: string | null;
}

/** The envelope every JSON endpoint uses. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** `POST /api/upload/check` */
export interface DuplicateCheckResult {
  success: boolean;
  exists: boolean;
  file?: FileInfo;
}

/** `POST /api/upload` */
export interface UploadResult {
  success: boolean;
  deduplicated: boolean;
  file: FileInfo;
}

/** An API token as listed in the admin panel. Never contains the plaintext. */
export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Response from `POST /api/tokens` — the plaintext is shown exactly once. */
export interface CreatedToken {
  id: string;
  name: string;
  token: string;
  createdAt: number;
}

/** `GET /api/files` */
export interface FileListResponse {
  files: FileInfo[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

/** `GET /api/me` */
export interface MeResponse {
  authenticated: boolean;
  admin: boolean;
  username?: string;
  principal?: 'admin' | 'token';
}

/** `GET /api/backup/status` */
export interface BackupStatus {
  exists: boolean;
  size: number;
  sha256: string | null;
  uploadedAt: number | null;
  cron: string;
}

/** The lifecycle of one queued upload, as shown in the UI. */
export type UploadState =
  | 'pending'
  | 'hashing'
  | 'checking'
  | 'duplicate'
  | 'uploading'
  | 'success'
  | 'failed';

/** One entry in the upload queue. */
export interface UploadTask {
  /** Stable id for DOM lookups. */
  key: string;
  file: File;
  state: UploadState;
  /** 0–1, only meaningful while uploading. */
  progress: number;
  /** Populated on success. */
  result?: UploadResult;
  /** Human-readable reason, populated on failure. */
  error?: string;
  /** How many times we have already retried. */
  attempts: number;
}

/** Turn a server-side `error` code into something a human can read. */
export function humanizeError(code: string): string {
  const map: Record<string, string> = {
    unauthorized: '登录已失效，请重新登录',
    admin_only: '需要管理员权限',
    forbidden: '没有权限',
    bad_origin: '请求来源不合法',
    missing_origin: '请求缺少来源信息',
    turnstile_failed: '人机验证失败，请重试',
    turnstile_missing: '请先完成人机验证',
    too_many_attempts: '尝试次数过多，请稍后再试',
    invalid_sha256: '文件校验值格式不正确',
    invalid_json: '请求格式错误',
    invalid_multipart: '上传数据格式错误',
    missing_file: '没有收到文件',
    file_must_be_a_file: '上传字段不是文件',
    empty_file: '文件内容为空',
    empty_filename: '文件名为空',
    size_mismatch: '文件大小校验失败',
    file_too_large: '文件超过大小限制',
    unsupported_file_type: '只支持图片（png、jpg、webp、gif、avif、svg、jxl、heic、tiff 等）',
    checksum_mismatch: '文件内容和校验值不一致',
    expected_multipart: '上传格式不正确',
    file_not_found: '文件不存在',
    token_not_found: 'Token 不存在',
    no_backup_available: '还没有可用的备份',
    name_required: '请填写 Token 名称',
    name_too_long: 'Token 名称过长',
    invalid_cursor: '分页参数无效，请刷新列表',
    timeout: '请求超时，请重试',
    upload_busy: '上传繁忙，请稍后重试',
    invalid_response: '服务器响应格式错误',
    unknown_endpoint: '接口不存在',
    internal_error: '服务器内部错误',
  };
  return map[code] ?? `请求失败（${code}）`;
}
