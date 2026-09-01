import { ApiError } from '../api'

export interface UploadSchedulerLimits {
  prepare: number
  upload: number
  video: number
}

export function getUploadSchedulerLimits(mobile: boolean, constrained = false): UploadSchedulerLimits {
  return { prepare: constrained ? 1 : mobile ? 1 : 2, upload: constrained ? 1 : mobile ? 2 : 3, video: 1 }
}

export function calculateRetryDelay(attempt: number, retryAfterMs?: number, random = Math.random()): number {
  if (retryAfterMs !== undefined) return Math.max(1_000, Math.min(retryAfterMs, 15 * 60_000))
  const ceiling = Math.min(1_000 * (2 ** Math.max(0, attempt - 1)), 60_000)
  return Math.max(500, Math.round(random * ceiling))
}

export function friendlyUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UPLOAD_ABORTED') return '任务已暂停。继续后会从安全阶段恢复。'
    if (error.code === 'REQUEST_TIMEOUT') return '请求超时，任务已保留并将在稍后重试。'
    if (error.status === 429) return 'Telegram 当前请求过多，已按服务端提示降低并发并稍后重试。'
    if (error.code === 'DUPLICATE_UPLOAD_IN_PROGRESS') return '相同原件正在另一项任务中保存，当前任务会等待并在完成后自动去重。'
    if (error.code === 'UPLOAD_ALREADY_IN_PROGRESS') return '同一原件正在另一个页面中上传，当前任务会等待已有上传完成。'
    if (error.status === 0 || error.code === 'NETWORK_OFFLINE' || error.code === 'ACCESS_OR_NETWORK_FAILED') {
      return '网络连接中断，任务已保留。恢复网络后会继续，不会重复上传已保存的原件。'
    }
    if (error.status === 401 && error.code === 'ACCESS_SIGN_IN_REQUIRED') return 'Cloudflare Access 登录已失效，请重新打开图库完成验证后重试。'
    if (error.status === 401 && error.code === 'APP_AUTH_REQUIRED') return 'Private Archive 账号登录已过期，重新登录后会继续保留的上传任务。'
    if (error.code === 'UPLOAD_TOKEN_INVALID_OR_EXPIRED') return '上传凭证已过期，系统会为同一文件刷新凭证后继续。'
    return `上传失败（${error.code}）`
  }
  return error instanceof Error ? error.message : '上传失败'
}
