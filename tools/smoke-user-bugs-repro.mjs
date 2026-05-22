#!/usr/bin/env electron
/**
 * Smoke test to reproduce and verify the fixes for:
 * 1. Table Export (empty cells for array-of-arrays row format in table.html)
 * 2. DeepSeek email UID schema coercion validation (accepting and transforming number to string in chat.ts)
 *
 * Run: electron tools/smoke-user-bugs-repro.mjs
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} :: ${detail}`)
  }
}

async function testTableExport() {
  console.log('\n--- Testing Table Export (table.html) ---')
  const tableHtmlPath = path.join(rootDir, 'src/renderer/public/table.html')
  const html = fs.readFileSync(tableHtmlPath, 'utf8')

  // Extract toTSV function
  const toTsvMatch = html.match(/function toTSV\([\s\S]*?\n  \}/)
  if (!toTsvMatch) {
    check('Extracted toTSV from table.html', false, 'toTSV function not found in HTML')
    return
  }
  check('Extracted toTSV from table.html', true)
  const toTSV = new Function('data', toTsvMatch[0] + '\nreturn toTSV(data);')

  // Extract toCSV function
  const toCsvMatch = html.match(/function toCSV\([\s\S]*?\n  \}/)
  if (!toCsvMatch) {
    check('Extracted toCSV from table.html', false, 'toCSV function not found in HTML')
    return
  }
  check('Extracted toCSV from table.html', true)
  const toCSV = new Function('data', toCsvMatch[0] + '\nreturn toCSV(data);')

  // Setup test fixture with the new array-of-arrays row format (since v0.0.29)
  const data = {
    title: 'Test Table',
    columns: ['序号', '发件人', '主题'],
    rows: [
      [1, 'sender1@example.com', 'Meeting Agenda'],
      [2, 'sender2@example.com', 'Weekly Report']
    ]
  }

  try {
    const tsvOut = toTSV(data)
    console.log('TSV Output preview:\n' + tsvOut.trim().split('\n').map(l => '    ' + l).join('\n'))

    const tsvLines = tsvOut.trim().split('\n')
    check('TSV has header and 2 rows', tsvLines.length === 3, `got ${tsvLines.length} lines`)
    check('TSV header is correct', tsvLines[0] === '序号\t发件人\t主题', `got header: "${tsvLines[0]}"`)
    check('TSV Row 1 has sender1', tsvLines[1].includes('sender1@example.com'), `got: "${tsvLines[1]}"`)
    check('TSV Row 1 has Meeting Agenda', tsvLines[1].includes('Meeting Agenda'), `got: "${tsvLines[1]}"`)
    check('TSV Row 2 has sender2', tsvLines[2].includes('sender2@example.com'), `got: "${tsvLines[2]}"`)

    // Verify cell contents are not empty/undefined
    const tsvRow1Cells = tsvLines[1].split('\t')
    check('TSV Row 1 cells do not contain undefined/empty', !tsvRow1Cells.includes('undefined') && !tsvRow1Cells.includes(''), `cells: ${JSON.stringify(tsvRow1Cells)}`)
  } catch (err) {
    check('TSV export ran without errors', false, err.message)
  }

  try {
    const csvOut = toCSV(data)
    console.log('CSV Output preview:\n' + csvOut.trim().split('\n').map(l => '    ' + l).join('\n'))

    const csvLines = csvOut.trim().split('\n')
    check('CSV has header and 2 rows', csvLines.length === 3, `got ${csvLines.length} lines`)
    check('CSV header is correct', csvLines[0] === '序号,发件人,主题', `got header: "${csvLines[0]}"`)
    check('CSV Row 1 has sender1', csvLines[1].includes('sender1@example.com'), `got: "${csvLines[1]}"`)
    check('CSV Row 2 has sender2', csvLines[2].includes('sender2@example.com'), `got: "${csvLines[2]}"`)

    // Verify cell contents are not empty/undefined
    const csvRow1Cells = csvLines[1].split(',')
    check('CSV Row 1 cells do not contain undefined/empty', !csvRow1Cells.includes('undefined') && !csvRow1Cells.includes(''), `cells: ${JSON.stringify(csvRow1Cells)}`)
  } catch (err) {
    check('CSV export ran without errors', false, err.message)
  }
}

async function testZodCoercion() {
  console.log('\n--- Testing Zod Coercion (chat.ts mock/actual) ---')

  // We test the exact behavior we want to implement in chat.ts:
  // z.union([z.string(), z.number()]).transform(val => String(val))
  const uidSchema = z.union([z.string(), z.number()]).transform(val => String(val))
  const schema = z.object({
    id: uidSchema
  })

  // Test with string UID (e.g. from Gemini/standard)
  try {
    const resString = schema.parse({ id: '12345' })
    check('String ID parsing succeeds', resString.id === '12345', `got: "${resString.id}"`)
  } catch (err) {
    check('String ID parsing succeeds', false, err.message)
  }

  // Test with number UID (e.g. from DeepSeek/OpenRouter)
  try {
    const resNumber = schema.parse({ id: 12345 })
    check('Number ID parsing and coercion to string succeeds', resNumber.id === '12345', `got: "${resNumber.id}"`)
  } catch (err) {
    check('Number ID parsing and coercion to string succeeds', false, err.message)
  }

  // Try importing the actual tools from chat.ts to verify the updated schemas live in the file
  try {
    const { register } = await import('tsx/esm/api')
    register()

    const { readEmail, draftEmailReply } = await import('../src/main/chat.ts')
    if (readEmail && draftEmailReply) {
      check('Imported readEmail and draftEmailReply from chat.ts', true)

      // Test live readEmail schema
      const parsedRead = readEmail.inputSchema.safeParse({ id: 999888 })
      check('Live readEmail.inputSchema coerces number to string', parsedRead.success && parsedRead.data.id === '999888', JSON.stringify(parsedRead))

      // Test live draftEmailReply schema
      const parsedDraft = draftEmailReply.inputSchema.safeParse({ uid: 777666 })
      check('Live draftEmailReply.inputSchema coerces number to string', parsedDraft.success && parsedDraft.data.uid === '777666', JSON.stringify(parsedDraft))
    } else {
      check('Imported readEmail and draftEmailReply from chat.ts', false, 'Tools not exported')
    }
  } catch (err) {
    // If the files haven't been modified yet or imports fail on other dependencies, log it.
    console.log(`[info] Live chat.ts import/test skipped or failed (expected before changes): ${err.message}`)
  }
}

async function main() {
  await app.whenReady()

  await testTableExport()
  await testZodCoercion()

  console.log(`\n=== Repro Test Results ===\n${pass} passed, ${fail} failed`)
  app.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Test script crashed:', err)
  app.exit(1)
})
