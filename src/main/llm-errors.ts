/**
 * Translate provider-side LLM errors into something a user can act on.
 *
 * Raw provider errors read like compiler output ("unknown variant
 * `image_url`", `{"code":"1113",...}`) and never say where to go to fix
 * them. Every chat error, wizard/Settings connectivity test, and side-task
 * failure that reaches the UI goes through here.
 *
 * Takes the error object (not just its message) because Vercel AI SDK's
 * APICallError carries statusCode + responseBody separately, and several
 * providers put the useful text only in the body.
 */

import { isModelUnavailableError } from '../shared/lightweight-models.js'
import { isLocalEndpoint } from '../shared/config.js'

function providerLabel(baseUrl: string): string {
  if (baseUrl.includes('bigmodel.cn')) return '智谱 GLM'
  if (baseUrl.includes('moonshot.cn')) return 'Kimi 国内版'
  if (baseUrl.includes('moonshot.ai')) return 'Kimi 国际版'
  if (baseUrl.includes('deepseek.com')) return 'DeepSeek'
  if (baseUrl.includes('googleapis.com')) return 'Gemini'
  if (baseUrl.includes('dashscope.aliyuncs.com')) return '通义千问'
  if (baseUrl.includes('volces.com') || baseUrl.includes('ark.cn-beijing')) return '豆包'
  if (baseUrl.includes('openai.com')) return 'OpenAI'
  if (baseUrl.includes('anthropic.com')) return 'Anthropic'
  if (isLocalEndpoint(baseUrl)) return '本地模型服务'
  return '当前 AI 服务'
}

/** Full raw text of an error: message + response body + nested cause. */
export function rawErrorText(err: unknown): string {
  if (err == null) return ''
  if (typeof err !== 'object') return String(err)
  const e = err as { message?: string; responseBody?: string; cause?: unknown }
  const parts = [e.message ?? String(err)]
  if (e.responseBody && !parts[0]!.includes(e.responseBody)) parts.push(e.responseBody)
  if (e.cause && e.cause !== err) parts.push(rawErrorText(e.cause))
  return parts.join(' ')
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number } | null
  return e?.statusCode ?? e?.status
}

export function friendlyLlmError(
  err: unknown,
  ctx: { baseUrl: string; modelId?: string },
): string {
  const raw = rawErrorText(err)
  const status = statusOf(err)
  const who = providerLabel(ctx.baseUrl)
  const tail = `（原始错误：${raw.replace(/\s+/g, ' ').slice(0, 140)}）`

  // Image sent to a text-only model. Vision routing in chat/run.ts should
  // prevent this; if a custom model id slips past the text-only table,
  // tell the user what happened instead of a deserializer dump.
  if (raw.includes('unknown variant `image_url`') || /content\.type 参数非法/.test(raw)) {
    return `当前模型${ctx.modelId ? `（${ctx.modelId}）` : ''}不能看图。去 Settings → AI 换一个支持图片的模型再发。${tail}`
  }
  // Gemini-specific message-sequence rejection. Should be prevented by
  // the pre-streamText sanding in chat/run.ts; if it still slips
  // through, point at the workaround.
  if (raw.includes('function call turn comes immediately after')) {
    return (
      'Gemini 拒绝了消息序列（它要求 tool 调用必须紧跟用户或上一个 tool 结果）。' +
      '通常重发就好；如果反复出现，可以临时换 GLM / Qwen / Doubao —— Settings → AI 顶部切换。'
    )
  }
  if (
    /"code"\s*:\s*"1113"|余额不足|欠费|insufficient[_ ](balance|quota)|exceeded your current quota|billing/i.test(raw) ||
    status === 402
  ) {
    const freeHint = ctx.baseUrl.includes('bigmodel.cn')
      ? '，或在 Settings → AI 把模型换成免费的 glm-4.6v-flash'
      : ''
    return `${who} 账户余额不足（赠送额度可能已经用完）。去平台充值${freeHint}。${tail}`
  }
  if (
    status === 401 ||
    /invalid[_ ]?(api[_ ]?key|authentication)|incorrect api key|unauthorized|身份验证|令牌已过期|API key not valid/i.test(raw)
  ) {
    const kimiHint = ctx.baseUrl.includes('moonshot')
      ? '注意 Kimi 国内版（platform.kimi.com）和国际版（platform.kimi.ai）的 key 不通用。'
      : ''
    return `${who} 的 API key 无效或已过期。去 Settings → AI 重新粘贴 key。${kimiHint}${tail}`
  }
  if (isModelUnavailableError(err)) {
    return `模型${ctx.modelId ? ` ${ctx.modelId} ` : ''}用不了（可能已被 ${who} 下线，或当前 key 没有权限）。去 Settings → AI 换一个模型。${tail}`
  }
  if (
    status === 429 ||
    status === 503 ||
    status === 529 ||
    /"code"\s*:\s*"1305"|访问量过大|rate[_ ]limit|overloaded|too many requests|concurrency/i.test(raw)
  ) {
    return `${who} 现在太忙或触发了限流，等几秒再试一次。${tail}`
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|socket hang up|timed? ?out/i.test(raw)) {
    if (isLocalEndpoint(ctx.baseUrl)) {
      return `连不上本地模型服务（${ctx.baseUrl}）。确认 LM Studio 已经启动、加载了模型，并且打开了 Local Server。${tail}`
    }
    return `连不上 ${who}，检查一下网络（国内访问海外服务可能需要代理）。${tail}`
  }
  return raw
}
