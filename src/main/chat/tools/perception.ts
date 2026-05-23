import { clipboard, dialog } from 'electron'
import { readFile as fsReadFile } from 'node:fs/promises'
import { extname } from 'node:path'
import * as mammoth from 'mammoth'

import { tool } from 'ai'
import { z } from 'zod'
import { Readability } from '@mozilla/readability'
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
    '抓取一个网页，提取出标题 + 正文，返回给你。' +
    '用户说"总结这个链接"、"读一下这个文章"、"这个网页讲什么"、' +
    '或者直接发一个 URL 等时调用。返回结构 { title, byline, content }。' +
    '`url` 必须是 http:// 或 https:// 开头的完整 URL。',
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
    '支持的文件类型：.txt .md .json .csv .yaml .py .ts 等纯文本，以及 .docx Word 文档（自动提取正文）。.pdf 暂时不支持，会被拒绝。',
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

      // Plain-text path: crude binary check (null byte in first 1KB
      // strongly suggests a binary file). Catches .pdf, .xlsx, etc. that
      // we don't have specific parsers for.
      const head = buf.subarray(0, Math.min(1024, buf.length))
      if (head.includes(0)) {
        return {
          error:
            `${absPath} 看起来是二进制文件（含有空字节），我读不了。` +
            (ext === '.pdf'
              ? ' PDF 暂时不支持，可以把内容复制到剪贴板或导出成 .txt / .docx 再让我看。'
              : ''),
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
