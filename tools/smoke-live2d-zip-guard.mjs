/**
 * Smoke test: Live2D model path guards (zip-slip, zip bomb, model names).
 *
 * `live2d-models-host.ts` needs Electron (`app.getPath`), so the safety
 * logic lives in the Electron-free `live2d-path-guard.ts` — this test
 * drives it directly, including with REAL adm-zip archives whose entry
 * names were forged after creation (adm-zip's addFile() strips `../`, the
 * entryName setter doesn't — same as a hand-crafted hostile zip).
 *
 * Covers:
 *   1. isSafeModelName — `..`, separators, NUL, un-sanitized names rejected
 *   2. sanitizeName is idempotent (imported names always pass the guard)
 *   3. isDirectChildDir — only immediate children of the models root
 *   4. resolveInside — traversal / absolute / drive letter / UNC / ADS
 *   5. planZipExtraction on real zips: hostile entry rejects the WHOLE zip
 *      and nothing is written; a benign zip extracts inside dst only
 *   6. zip-bomb limits: entry count, total declared size, size=0 lie
 *
 * Run: npm run test:live2d-zip-guard
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'

const {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  sanitizeName,
  isSafeModelName,
  isDirectChildDir,
  resolveInside,
  planZipExtraction,
} = await import('../src/main/live2d-path-guard.ts')

let passed = 0
let failed = 0

function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
    failed++
  }
}

function throws(fn, re) {
  try {
    fn()
    return false
  } catch (err) {
    return re ? re.test(String(err?.message ?? err)) : true
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'live2d-guard-'))
const root = join(tmp, 'userData', 'live2d-models')
mkdirSync(root, { recursive: true })

try {
  // ---- 1. model names ----
  console.log('\n[1: isSafeModelName]')
  for (const ok of ['hiyori_pro_en', 'haitu_vts', '中文模型', 'Model v2', 'a.b']) {
    check(`accepts ${JSON.stringify(ok)}`, isSafeModelName(ok))
  }
  for (const bad of [
    '', '.', '..', '...', 'a/b', 'a\\b', '../x', '..\\..', 'a\0b', ' lead', 'trail.',
    'a:b', 'x'.repeat(97), 'C:', null, undefined, 42,
  ]) {
    check(`rejects ${JSON.stringify(bad)}`, !isSafeModelName(bad))
  }

  // ---- 2. sanitizeName idempotent ----
  console.log('\n[2: sanitizeName]')
  const samples = [
    'Hiyori', '..', '../../evil', ' .x. ', 'a'.repeat(95) + ' b', 'a'.repeat(95) + '.b',
    'x:y*z?"<>|', 'ctl\u0001\u001fchar', '模型/子目录',
  ]
  for (const s of samples) {
    const once = sanitizeName(s)
    check(
      `idempotent + guard-safe: ${JSON.stringify(s.slice(0, 20))} → ${JSON.stringify(once.slice(0, 20))}`,
      sanitizeName(once) === once && (once === '' || isSafeModelName(once)),
    )
  }
  check('".." sanitizes to empty (importZip then bails)', sanitizeName('..') === '')

  // ---- 3. direct child ----
  console.log('\n[3: isDirectChildDir]')
  check('root/x is a direct child', isDirectChildDir(root, join(root, 'x')))
  check('root itself is not', !isDirectChildDir(root, root))
  check('root/.. is not', !isDirectChildDir(root, join(root, '..')))
  check('root/a/b is not', !isDirectChildDir(root, join(root, 'a', 'b')))
  check('sibling dir is not', !isDirectChildDir(root, join(dirname(root), 'other')))

  // ---- 4. resolveInside ----
  console.log('\n[4: resolveInside]')
  const dst = join(root, 'm')
  for (const ok of ['a.png', 'runtime/x.model3.json', './a.txt', 'dir\\file.moc3', 'a/./b']) {
    const out = resolveInside(dst, ok)
    check(`accepts ${JSON.stringify(ok)}`, !!out && out.startsWith(resolve(dst) + sep), String(out))
  }
  for (const bad of [
    '', '.', './', '..', '../x', 'a/../../x', 'a/..', '..\\..\\x', '/etc/passwd',
    '\\\\server\\share\\x', '//server/share/x', 'C:/Windows/x', 'C:\\Windows\\x', 'c:foo',
    'a\0b', '...', 'a/.. /b', 'a.png:ads', 'a/b:c/d',
  ]) {
    check(`rejects ${JSON.stringify(bad)}`, resolveInside(dst, bad) === null)
  }

  // ---- 5. real zips ----
  console.log('\n[5: planZipExtraction on real adm-zip archives]')
  function forgedZip(names) {
    const z = new AdmZip()
    for (const [i, name] of names.entries()) {
      const e = z.addFile(`placeholder-${i}.txt`, Buffer.from(`file ${i}`))
      e.entryName = name // bypass addFile's own sanitizing, like a hand-made zip
    }
    return new AdmZip(z.toBuffer())
  }

  const hostile = [
    ['Model/../../../evil.txt'],
    ['Model/..\\..\\..\\evil.txt'],
    ['C:/Users/Public/evil.txt'],
    ['/tmp/evil.txt'],
    ['Model/a.png:hidden'],
  ]
  for (const extra of hostile) {
    const zip = forgedZip(['Model/model.model3.json', 'Model/tex.png', ...extra])
    const entries = zip.getEntries()
    check(
      `forged entry survives the round-trip: ${extra[0]}`,
      entries.some((e) => e.entryName === extra[0]),
    )
    const target = join(root, 'Model')
    check(
      `whole zip rejected: ${extra[0]}`,
      throws(() => planZipExtraction(entries, target, 'Model'), /不安全的路径/),
    )
    check(`nothing written for ${extra[0]}`, !existsSync(target) && !existsSync(join(tmp, 'evil.txt')))
  }

  // Benign zip — plan, then write exactly like importZip does, and verify
  // every file landed under dst.
  {
    const zip = forgedZip(['Model/model.model3.json', 'Model/runtime/tex_00.png', 'Model/motions/idle.motion3.json'])
    const target = join(root, 'Model')
    const plan = planZipExtraction(zip.getEntries(), target, 'Model')
    check('benign zip: 3 files planned', plan.length === 3, `got ${plan.length}`)
    check(
      'benign zip: every path inside dst',
      plan.every((p) => p.outPath.startsWith(resolve(target) + sep)),
    )
    check(
      'benign zip: top dir stripped',
      plan.some((p) => p.outPath === resolve(target, 'model.model3.json')),
    )
    for (const { entry, outPath } of plan) {
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, entry.getData())
    }
    check('benign zip: extracted', readdirSync(target).includes('model.model3.json'))
    check('benign zip: nothing outside the models root', readdirSync(tmp).join(',') === 'userData')
  }

  // Directory entries are skipped, even hostile ones — never created.
  {
    const zip = forgedZip(['Model/model.model3.json'])
    const entries = [...zip.getEntries(), { entryName: '../../evil-dir/', isDirectory: true, header: { size: 0, compressedSize: 0 } }]
    check('hostile DIR entry is ignored (never mkdir-ed)', planZipExtraction(entries, join(root, 'D'), 'Model').length === 1)
  }

  // ---- 6. zip-bomb limits ----
  console.log('\n[6: zip-bomb limits]')
  const fake = (entryName, size, compressedSize = 10) => ({
    entryName,
    isDirectory: false,
    header: { size, compressedSize },
  })
  const many = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => fake(`f${i}.png`, 1))
  check(`> ${MAX_ZIP_ENTRIES} entries rejected`, throws(() => planZipExtraction(many, dst, null), /文件太多/))
  const atLimit = many.slice(0, MAX_ZIP_ENTRIES)
  check(`exactly ${MAX_ZIP_ENTRIES} entries allowed`, planZipExtraction(atLimit, dst, null).length === MAX_ZIP_ENTRIES)
  const half = Math.floor(MAX_ZIP_TOTAL_BYTES / 2) + 1
  check(
    'declared total > 1 GB rejected (before any getData)',
    throws(() => planZipExtraction([fake('a.png', half), fake('b.png', half)], dst, null), /解压后超过/),
  )
  check(
    'declared total == 1 GB allowed',
    planZipExtraction([fake('a.png', MAX_ZIP_TOTAL_BYTES)], dst, null).length === 1,
  )
  check(
    'size=0 with big compressed payload rejected',
    throws(() => planZipExtraction([fake('a.png', 0, 50_000)], dst, null), /大小字段异常/),
  )
  check('honest empty file allowed', planZipExtraction([fake('empty.txt', 0, 2)], dst, null).length === 1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
