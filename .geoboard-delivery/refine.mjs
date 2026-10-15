import fs from 'node:fs'
const file = 'tests/geoboard.integration.test.ts'
let text = fs.readFileSync(file, 'utf8')
function replace(before, after) {
  if (text.split(before).length !== 2) throw new Error(`Integration anchor differs: ${before}`)
  text = text.replace(before, after)
}
replace("it('accepts old math drafts without creating a new field or changing their bytes'", "it('accepts old math drafts without adding fields or mutating the original input'")
replace('expect(JSON.stringify(mathWorkbenchSchema.parse(old))).toBe(bytes)', `const parsed = mathWorkbenchSchema.parse(old)
    expect(parsed).toEqual(old)
    expect(Object.hasOwn(parsed, 'geoboard')).toBe(false)
    expect(JSON.stringify(old)).toBe(bytes)`)
replace('expect(JSON.stringify(studyStateSchema.parse(old))).toBe(bytes)', `const parsed = studyStateSchema.parse(old)
    expect(parsed).toEqual(old)
    expect(Object.hasOwn(parsed.drafts.legacy.math!, 'geoboard')).toBe(false)
    expect(JSON.stringify(old)).toBe(bytes)`)
replace("import { mkdtemp, rm } from 'node:fs/promises'", "import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'")
text += `
it('opening legacy records preserves their actual on-disk bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-geoboard-legacy-'))
  try {
    const original = { version: 1, drafts: { legacy: emptyDraft('math') }, attempts: [] }
    const bytes = JSON.stringify(original, null, 4) + '\\n'
    const file = join(directory, 'study-state.json')
    await writeFile(file, bytes, 'utf8')
    const service = new StudyService(directory, new LocalQuestionBank(directory), new LocalRuleAgent())
    const loaded = await service.loadState()
    expect(loaded).toEqual(original)
    expect(Object.hasOwn(loaded.drafts.legacy.math!, 'geoboard')).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
`
fs.writeFileSync(file, text)
