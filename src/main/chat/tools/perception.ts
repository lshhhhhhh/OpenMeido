import { clipboard, dialog } from 'electron'
import { readFile as fsReadFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as mammoth from 'mammoth'

import { tool } from 'ai'
import { z } from 'zod'
import { Readability } from '@mozilla/readability'

/**
 * Pull plain text out of a PDF buffer via pdfjs-dist's legacy build.
 * Legacy build is the right choice for Node/Electron-main: it ships
 * a single-bundle .mjs that doesn't try to spin up a worker thread
 * (worker setup is browser-only and just throws here). We also
 * disable eval so V8's CSP doesn't yell.
 *
 * Text-only extraction — we drop fonts, positioning, images, tables.
 * Good enough for LLM summarization; not for fidelity rendering.
 */
async function extractPdfText(buf: Buffer): Promise<string> {
  // Dynamic import keeps pdfjs out of the cold-boot path — it's a
  // ~3MB lib and we only pay for it when a user actually opens a PDF.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // workerSrc must be set to something or the loader complains. We
  // use disableWorker so the value is moot, but the property has to
  // exist. Empty string is the convention.
  pdfjs.GlobalWorkerOptions.workerSrc = ''
  const data = new Uint8Array(buf)
  // disableWorker isn't in pdfjs v5's TS def but is honored at runtime —
  // legacy build's loader checks it before attempting worker setup, which
  // otherwise throws in Node. Cast to bypass the type guard.
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableWorker: true,
  } as Parameters<typeof pdfjs.getDocument>[0]).promise
  const pageTexts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? (item as { str: string }).str : ''))
      .join(' ')
    pageTexts.push(text)
  }
  return pageTexts.join('\n\n')
}
// linkedom > jsdom for our use: pure-JS, no CJS/ESM transitive-dep mess (jsdom
// pulls @exodus/bytes which is ESM-only and breaks Vite's CJS bundling for
// the Electron main process). API is compatible with what Readability needs.
import { parseHTML } from 'linkedom'

export const readClipboard = tool({
  description:
    '读取用户当前剪贴板里的纯文本内容。用户说"看看我刚复制的"、' +
    '"剪贴板里那段是啥"、"帮我翻译/总结刚复制的"等时调用。' +
    '返回完整的剪贴板文本（截断到 20KB），可能为空字符串（用户没复制东西）。',
  inputSchema: z.object({}),
  execute: async () => {
    const text = clipboard.readText()
    if (!text || !text.trim()) {
      return { empty: true, text: '', note: '剪贴板里没有文本内容（可能是图片或者根本没复制东西）。' }
    }
    const MAX = 20_000
    const out = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
    return { text: out, length: text.length }
  },
})

export const readWebPage = tool({
  description:
    '抓取**用户明确给出的某个网页 URL**，提取标题 + 正文。' +
    '仅在用户**自己粘了一个 http(s) 链接**并要你读/总结它时调用' +
    '（"总结这个链接"、"读一下 https://… 这篇"、"这个网页讲什么 + 链接"）。\n' +
    '**关键限制**：\n' +
    '- 用户没给具体 URL 时，**绝对不要**调用本工具。尤其是问"现在/最新/今天 X 是多少"、' +
    '"最近新闻"、"谁是当前的 X"这类时效性问题——你已经有联网搜索能力（系统自动处理），' +
    '**直接回答即可**，不要瞎编一个 URL 来读。瞎编的 URL 会抓取失败，反复重试只会浪费步数、最后什么都答不出来。\n' +
    '- 抓取失败（返回 error）时**不要换个 URL 重试**，如实告诉用户这个链接读不了。\n' +
    '`url` 必须是用户给的、http:// 或 https:// 开头的完整 URL。返回 { title, byline, content }。',
  inputSchema: z.object({
    url: z.string().describe('Full HTTP/HTTPS URL of the page to fetch and extract.'),
  }),
  execute: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) {
      return { error: '只支持 http:// 或 https:// 开头的完整 URL，不要传相对路径或单独的域名。' }
    }
    try {
      const ctl = new AbortController()
      // 20s timeout — slow CDN + Readability parse + everything else.
      const timer = setTimeout(() => ctl.abort(), 20_000)
      let res: Response
      try {
        res = await fetch(url, {
          headers: {
            // Some sites 403 on non-browser UA. Pretend to be Chrome.
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: ctl.signal,
          redirect: 'follow',
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) return { error: `HTTP ${res.status} from ${url}` }
      const ct = res.headers.get('content-type') || ''
      if (!/text\/html|application\/xhtml/i.test(ct)) {
        return { error: `${url} 返回的不是 HTML（content-type=${ct}），无法用 Readability 提取正文。` }
      }
      const html = await res.text()
      // linkedom's parseHTML returns { document, window, ... }. Readability
      // only touches `document`, so the parts of jsdom it doesn't replicate
      // (XHR, canvas, etc.) don't matter for us.
      const { document } = parseHTML(html)
      const reader = new Readability(document as unknown as Document)
      const article = reader.parse()
      if (!article || !article.textContent || article.textContent.trim().length < 40) {
        return { error: `Readability 无法从 ${url} 提取到正文（页面可能是 SPA、登录墙、或纯图片）。` }
      }
      // Cap text — 8000 chars covers any reasonable article and keeps the
      // model context bounded.
      const MAX = 8_000
      const trimmed = article.textContent.trim()
      const content = trimmed.length > MAX ? trimmed.slice(0, MAX) + '\n…[截断]' : trimmed
      return {
        title: article.title ?? '',
        byline: article.byline ?? '',
        excerpt: article.excerpt ?? '',
        content,
        url,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('aborted') || msg.includes('AbortError')) {
        return { error: `抓取 ${url} 超时（20 秒），网站可能太慢或被防火墙拦了。` }
      }
      return { error: msg }
    }
  },
})

export const readFileTool = tool({
  description:
    '读取本地一个文本文件，返回文件内容供你总结或回答关于它的问题。\n' +
    '用户说"总结这个文件"、"打开 X 给我看看"、"读一下 readme"、' +
    '"我桌面上那个 X.md 写了啥"等时调用。\n' +
    '`path` 可以填具体的绝对路径（用户给的）；或者填空字符串 `""`，' +
    '系统会弹出文件选择器让用户挑文件。**用户没提路径时务必传空字符串**，' +
    '不要瞎编路径。\n' +
    '支持的文件类型：.txt .md .json .csv .yaml .py .ts 等纯文本，.docx Word 文档（自动提取正文），以及 .pdf（自动提取纯文本，丢失版式和图片）。',
  inputSchema: z.object({
    path: z
      .string()
      .describe(
        'Absolute file path, or empty string "" to pop up a file picker for the user.',
      ),
  }),
  execute: async ({ path }) => {
    let absPath = path.trim()
    if (!absPath) {
      // Empty path → pop a picker. Showing the dialog is a user-visible
      // action; we rely on the user clicking through to provide consent.
      const result = await dialog.showOpenDialog({
        title: '选择要总结的文件',
        properties: ['openFile'],
        filters: [
          { name: '文本/Markdown', extensions: ['txt', 'md', 'mdx', 'rst', 'log'] },
          { name: 'Word 文档', extensions: ['docx'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: '配置/数据', extensions: ['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini'] },
          {
            name: '代码',
            extensions: [
              'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
              'py', 'go', 'rs', 'java', 'kt',
              'c', 'cpp', 'cc', 'h', 'hpp',
              'rb', 'php', 'sh', 'ps1', 'bat',
              'html', 'css', 'scss', 'sass',
              'sql', 'vue', 'svelte',
            ],
          },
          { name: '全部文件', extensions: ['*'] },
        ],
      })
      if (result.canceled || !result.filePaths[0]) {
        return { error: '用户取消了文件选择。' }
      }
      absPath = result.filePaths[0]
    }
    try {
      const buf = await fsReadFile(absPath)
      const ext = extname(absPath).toLowerCase()
      const MAX = 60_000

      // .docx is a zip with XML inside; null-byte check would reject it.
      // Route through mammoth which extracts plain text (no images, no
      // tables — those become tab-separated lines).
      if (ext === '.docx') {
        try {
          const { value } = await mammoth.extractRawText({ buffer: buf })
          const text = value ?? ''
          const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
          return {
            path: absPath,
            sizeBytes: buf.length,
            sizeChars: text.length,
            content,
            truncated: text.length > MAX,
            format: 'docx',
          }
        } catch (err) {
          return {
            error: `读取 docx 失败: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      // PDF: route through pdfjs-dist for plain-text extraction.
      // We do this BEFORE the binary-check below — PDFs ARE binary
      // (start with %PDF header, contain null bytes downstream)
      // so the heuristic would otherwise reject them.
      if (ext === '.pdf') {
        try {
          const text = await extractPdfText(buf)
          const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
          return {
            path: absPath,
            sizeBytes: buf.length,
            sizeChars: text.length,
            content,
            truncated: text.length > MAX,
            format: 'pdf',
          }
        } catch (err) {
          return {
            error: `读取 PDF 失败: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      // Plain-text path: crude binary check (null byte in first 1KB
      // strongly suggests a binary file). Catches .xlsx etc. that we
      // don't have specific parsers for.
      const head = buf.subarray(0, Math.min(1024, buf.length))
      if (head.includes(0)) {
        return {
          error: `${absPath} 看起来是二进制文件（含有空字节），我读不了。`,
        }
      }
      const text = buf.toString('utf-8')
      const content = text.length > MAX ? text.slice(0, MAX) + '\n…[截断]' : text
      return {
        path: absPath,
        sizeBytes: buf.length,
        sizeChars: text.length,
        content,
        truncated: text.length > MAX,
        format: 'text',
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
})
