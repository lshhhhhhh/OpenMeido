#!/usr/bin/env node
/**
 * Deterministic smoke test for docx parsing. Constructs a minimal valid
 * .docx file in memory via adm-zip (already a project dep), runs it
 * through mammoth, and asserts the text comes back. No fixture files
 * checked in.
 *
 * Verifies the parsing layer that `readFile` tool uses for .docx — the
 * AI-routing part is covered by the broader agent tests.
 *
 * Run: npm run test:docx-parse
 */
import AdmZip from 'adm-zip'
import * as mammoth from 'mammoth'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} :: ${detail}`)
  }
}

/**
 * Build a minimal valid .docx (a zip with [Content_Types].xml,
 * _rels/.rels, and word/document.xml). The document holds one paragraph
 * per `paragraphs` entry. Returns a Buffer.
 */
function buildDocx(paragraphs) {
  const zip = new AdmZip()

  // Content-Types: declares the mime types for each path.
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      'utf-8',
    ),
  )

  // Package-level relationships: points to word/document.xml as the main doc.
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      'utf-8',
    ),
  )

  // The actual document body: one <w:p> per paragraph.
  const bodyParagraphs = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${p
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</w:t></w:r></w:p>`,
    )
    .join('')

  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParagraphs}
  </w:body>
</w:document>`,
      'utf-8',
    ),
  )

  return zip.toBuffer()
}

async function main() {
  console.log('\n[basic single-paragraph extraction]')
  {
    const buf = buildDocx(['Hello from a fake docx.'])
    const { value } = await mammoth.extractRawText({ buffer: buf })
    check('value contains the paragraph text', value.includes('Hello from a fake docx'), `got: "${value}"`)
  }

  console.log('\n[multi-paragraph preserves order]')
  {
    const buf = buildDocx(['First paragraph.', 'Second one.', '第三段（中文）。'])
    const { value } = await mammoth.extractRawText({ buffer: buf })
    check(
      'all three paragraphs present',
      value.includes('First') && value.includes('Second') && value.includes('第三段'),
      `got: "${value}"`,
    )
    check(
      'First comes before Second',
      value.indexOf('First') < value.indexOf('Second'),
    )
  }

  console.log('\n[unicode survives the round-trip]')
  {
    const text = '你好，主人。今天的待办事项包括：1. 回邮件 2. 写周报'
    const buf = buildDocx([text])
    const { value } = await mammoth.extractRawText({ buffer: buf })
    check(
      'Chinese text comes through intact',
      value.includes('待办事项') && value.includes('回邮件'),
      `got: "${value}"`,
    )
  }

  console.log('\n[XML-special chars get escaped properly]')
  {
    const text = '<script>alert("hi")</script> & "quoted" & more'
    const buf = buildDocx([text])
    const { value } = await mammoth.extractRawText({ buffer: buf })
    check(
      'escaped chars survive — & and < come back literal',
      value.includes('<script>') && value.includes('&'),
      `got: "${value}"`,
    )
  }

  console.log('\n[empty doc produces empty value]')
  {
    const buf = buildDocx([])
    const { value } = await mammoth.extractRawText({ buffer: buf })
    check('empty docx → empty/whitespace value', value.trim().length === 0, `got: "${value}"`)
  }

  console.log('\n[invalid input produces an error, not a crash]')
  {
    try {
      const garbage = Buffer.from('this is not a docx', 'utf-8')
      await mammoth.extractRawText({ buffer: garbage })
      check('mammoth rejects non-docx buffer', false, 'expected to throw')
    } catch {
      check('mammoth rejects non-docx buffer', true)
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
