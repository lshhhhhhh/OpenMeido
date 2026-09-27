import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Content-Security-Policy for the renderer, injected into the BUILT
 * index.html only (the dev server needs inline scripts for React Refresh
 * and a websocket for HMR). Defense in depth behind React's escaping and
 * the main window's will-navigate guard: no remote or inline scripts, no
 * plugins / frames.
 *
 *   - 'unsafe-eval': PixiJS 7 compiles shader uniform sync with
 *     `new Function` (Live2D rendering breaks without it).
 *   - style 'unsafe-inline': the inline <style> in index.html + React
 *     style attributes.
 *   - meido-live2d: / meido-bg: / meido-font: are our custom protocols
 *     (model files, backgrounds, bundled fonts).
 *   - file: because packaged builds load the page from disk.
 */
const RENDERER_CSP = [
  "default-src 'self' file:",
  "script-src 'self' file: 'unsafe-eval'",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob: meido-live2d: meido-bg:",
  "font-src 'self' file: data: meido-font:",
  "media-src 'self' file: data: blob:",
  "connect-src 'self' file: data: blob: meido-live2d: meido-bg: meido-font:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function injectCsp(): Plugin {
  return {
    name: 'openmeido-inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`,
      )
    },
  }
}

export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps every package.json `dependencies` entry
    // out of the bundle so Node loads them from node_modules at runtime.
    // Required for native modules (better-sqlite3, sqlite-vec) whose .node
    // binaries can't be statically resolved by Rollup, and a nice perf win
    // for big pure-JS deps too (electron-store, @ai-sdk/*).
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react(), injectCsp()],
  },
})
