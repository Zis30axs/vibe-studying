import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { FormulaReference } from '../src/components/FormulaReference'
import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from '../src/domain/formula-catalog'

it('renders offline formulas as accessible text with conditions, symbols, pitfalls and worked examples', () => {
  const html = renderToStaticMarkup(createElement(FormulaReference))
  expect(html).toContain('aria-label="公式速查"')
  expect(html).toContain('aria-label="公式列表"')
  expect(html).toContain('aria-describedby="formula-search-help"')
  expect(html).toContain('aria-controls="formula-detail"')
  expect(html).toContain('aria-current="true"')
  expect(html).toContain('符号与单位')
  expect(html).toContain('适用条件')
  expect(html).toContain('易错提醒')
  expect(html).toContain('小例题')
  expect(html).toContain('如何使用公式速查')
  expect(html).toContain(FORMULA_ENTRIES[0].title)
  expect(html).toContain(FORMULA_CATALOG_VERSION)
  expect(html).toContain('来源网址（可复制）')
  // Electron intentionally blocks external navigation, so sources are honest copyable URLs.
  expect(html).toMatch(/readonly=""/i)
  expect(html).not.toContain('target="_blank"')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('<iframe')
})

it('reports denied localStorage access instead of crashing or claiming a persisted favorite', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.defineProperty({}, 'localStorage', {
        get() {
          throw new Error('Storage access denied')
        },
      }),
    })
    const html = renderToStaticMarkup(createElement(FormulaReference))
    expect(html).toContain('收藏暂时只保留在本次会话，无法保存到本机')
    expect(html).toContain('aria-label="公式列表"')
    expect(html).not.toContain('已保存到本机。')
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

it('keeps unsupported future favorite data untouched while displaying an honest session-only notice', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let writes = 0
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => JSON.stringify({ version: 99, ids: [FORMULA_ENTRIES[0].id] }),
          setItem: () => {
            writes++
          },
        },
      },
    })
    const html = renderToStaticMarkup(createElement(FormulaReference))
    expect(html).toContain('本机收藏来自较新版本，已保留原数据')
    expect(html).toContain('本次收藏仅在当前会话有效')
    expect(writes).toBe(0)
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
