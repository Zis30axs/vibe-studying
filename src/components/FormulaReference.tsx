import { useEffect, useState } from 'react'
import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from '../domain/formula-catalog'
import {
  FORMULA_SUBJECT_LABELS,
  parseFormulaFavorites,
  readFormulaFavorites,
  searchFormulas,
  writeFormulaFavorites,
  type FormulaFavoritesResult,
} from '../domain/formula-reference'
import type { FormulaEntry, FormulaSubject } from '../shared/formula-reference'
import './formula-reference.css'

const persistenceUnavailable = '收藏暂时只保留在本次会话，无法保存到本机；刷新或关闭后可能丢失。'
function initialFavorites(): FormulaFavoritesResult {
  try {
    return typeof window === 'undefined'
      ? parseFormulaFavorites(null)
      : readFormulaFavorites(window.localStorage)
  } catch {
    return { ...parseFormulaFavorites(null), status: 'unavailable' }
  }
}
function saveFavorites(ids: string[]): boolean {
  try {
    return writeFormulaFavorites(window.localStorage, ids)
  } catch {
    return false
  }
}
const favoritesMessage = (status: FormulaFavoritesResult['status']) => {
  if (status === 'unavailable') return persistenceUnavailable
  if (status === 'invalid') return '原收藏数据无法读取，已恢复为空列表；重新收藏可保存新的列表。'
  if (status === 'unsupported')
    return '本机收藏来自较新版本，已保留原数据。本次收藏仅在当前会话有效。'
  if (status === 'migrated') return '已更新收藏格式，并保留当前公式库仍收录的条目。'
  if (status === 'repaired') return '已清理重复或不再收录的收藏条目。'
  return ''
}

/** Mounted once by App so short trips to the reader preserve its current view. */
export function FormulaReference() {
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState<FormulaSubject | 'all'>('all')
  const [chapter, setChapter] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [selectedId, setSelectedId] = useState(FORMULA_ENTRIES[0]?.id ?? '')
  const [initial] = useState(initialFavorites)
  const [favorites, setFavorites] = useState(initial.favorites.ids)
  const [notice, setNotice] = useState(favoritesMessage(initial.status))
  const chapters = [
    ...new Set(
      FORMULA_ENTRIES.filter((entry) => subject === 'all' || entry.subject === subject).map(
        (entry) => entry.chapter,
      ),
    ),
  ]
  const results = searchFormulas(query, {
    ...(subject === 'all' ? {} : { subject }),
    ...(chapter ? { chapter } : {}),
  }).filter((entry) => !favoritesOnly || favorites.includes(entry.id))
  const selected = results.find((entry) => entry.id === selectedId) ?? results[0]

  useEffect(() => {
    if (initial.status === 'migrated' || initial.status === 'repaired') {
      if (!saveFavorites(initial.favorites.ids)) setNotice(persistenceUnavailable)
    }
  }, [initial])

  function toggleFavorite(entry: FormulaEntry) {
    const next = favorites.includes(entry.id)
      ? favorites.filter((id) => id !== entry.id)
      : [...favorites, entry.id]
    setFavorites(next)
    if (initial.status === 'unsupported') return
    setNotice(
      saveFavorites(next)
        ? `${favorites.includes(entry.id) ? '已取消收藏' : '已收藏'}：${entry.title}。已保存到本机。`
        : persistenceUnavailable,
    )
  }
  function clearFilters() {
    setQuery('')
    setSubject('all')
    setChapter('')
    setFavoritesOnly(false)
  }

  return (
    <section className="formula-reference" aria-label="公式速查">
      <header className="formula-header">
        <div>
          <span className="eyebrow">FORMULA REFERENCE</span>
          <h2>从公式，到适用条件。</h2>
          <p>先核对条件与单位，再代入数值。数学与地理常用公式，随时离线查阅。</p>
        </div>
        <span className="formula-local-badge">本地公式库 · {FORMULA_ENTRIES.length} 条</span>
      </header>

      <div className="formula-controls">
        <label className="formula-search">
          <span>搜索公式</span>
          <input
            type="search"
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="如：向量夹角、cos、地方时"
            aria-describedby="formula-search-help"
          />
        </label>
        <label>
          <span>学科</span>
          <select
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value as FormulaSubject | 'all')
              setChapter('')
            }}
          >
            <option value="all">全部学科</option>
            <option value="math">数学</option>
            <option value="geography">地理</option>
          </select>
        </label>
        <label>
          <span>章节</span>
          <select value={chapter} onChange={(event) => setChapter(event.target.value)}>
            <option value="">全部章节</option>
            {chapters.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="formula-favorites-filter"
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly(!favoritesOnly)}
        >
          <span aria-hidden="true">{favoritesOnly ? '★' : '☆'}</span> 只看收藏（{favorites.length}）
        </button>
      </div>
      <p id="formula-search-help" className="formula-search-help">
        支持中文名称、英文别名和符号；多个关键词用空格分隔。筛选不会修改题目或答卷。
      </p>
      {notice && (
        <p className="formula-notice" role="status">
          {notice}
        </p>
      )}
      <div className="formula-results-heading">
        <p role="status" aria-live="polite" aria-atomic="true">
          找到 {results.length} 条公式{favoritesOnly ? ' · 仅收藏' : ''}
        </p>
        {(query || subject !== 'all' || chapter || favoritesOnly) && (
          <button type="button" onClick={clearFilters}>
            清除筛选
          </button>
        )}
      </div>

      {selected ? (
        <div className="formula-layout">
          <nav className="formula-index" aria-label="公式列表">
            <ul>
              {results.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={entry.id === selected.id ? 'true' : undefined}
                    aria-controls="formula-detail"
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span className="formula-index-meta">
                      {FORMULA_SUBJECT_LABELS[entry.subject]} · {entry.chapter}
                      {favorites.includes(entry.id) && <span aria-label="已收藏"> ★</span>}
                    </span>
                    <strong>{entry.title}</strong>
                    <span className="formula-index-expression">{entry.expression}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <article
            id="formula-detail"
            className="formula-detail"
            aria-labelledby="formula-detail-title"
          >
            <div className="formula-detail-heading">
              <div>
                <p className="formula-category">
                  {FORMULA_SUBJECT_LABELS[selected.subject]} · {selected.chapter}
                </p>
                <h3 id="formula-detail-title">{selected.title}</h3>
              </div>
              <button
                type="button"
                className="formula-favorite"
                aria-label={`${favorites.includes(selected.id) ? '取消收藏' : '收藏'}：${selected.title}`}
                aria-pressed={favorites.includes(selected.id)}
                onClick={() => toggleFavorite(selected)}
              >
                <span aria-hidden="true">{favorites.includes(selected.id) ? '★' : '☆'}</span>{' '}
                {favorites.includes(selected.id) ? '已收藏' : '收藏'}
              </button>
            </div>
            <p className="formula-expression" aria-label="公式表达式">
              {selected.expression}
            </p>
            <section aria-labelledby="formula-symbols-title">
              <h4 id="formula-symbols-title">符号与单位</h4>
              <dl className="formula-symbols">
                {selected.symbols.map((item, index) => (
                  <div key={`${item.symbol}-${index}`}>
                    <dt>{item.symbol}</dt>
                    <dd>
                      {item.meaning}
                      {item.unit && <span className="formula-unit">单位：{item.unit}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="formula-conditions" aria-labelledby="formula-conditions-title">
              <h4 id="formula-conditions-title">适用条件</h4>
              <ul>
                {selected.conditions.map((condition, index) => (
                  <li key={index}>{condition}</li>
                ))}
              </ul>
            </section>
            <section className="formula-pitfalls" aria-labelledby="formula-pitfalls-title">
              <h4 id="formula-pitfalls-title">易错提醒</h4>
              <ul>
                {selected.pitfalls.map((pitfall, index) => (
                  <li key={index}>{pitfall}</li>
                ))}
              </ul>
            </section>
            <section className="formula-example" aria-labelledby="formula-example-title">
              <h4 id="formula-example-title">小例题</h4>
              <p>{selected.example.question}</p>
              <ol>
                {selected.example.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              <p className="formula-example-answer">结果：{selected.example.answer}</p>
            </section>
            <p className="formula-entry-version">
              公式 ID：{selected.id} · 条目版本 {selected.version} · 公式库{' '}
              {FORMULA_CATALOG_VERSION}
            </p>
            <details className="formula-sources" key={selected.id}>
              <summary>参考来源与别名</summary>
              <p>检索别名：{selected.aliases.join('、')}</p>
              <ul>
                {selected.sources.map((source, index) => (
                  <li key={index}>
                    <strong>{source.title}</strong>
                    <label className="formula-source-url">
                      来源网址（可复制）
                      <textarea
                        readOnly
                        value={source.url}
                        rows={2}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </label>
                  </li>
                ))}
              </ul>
              <p>可复制网址到浏览器查阅，外部来源需要联网。以课堂教材的符号约定与适用范围为准。</p>
            </details>
          </article>
        </div>
      ) : (
        <div className="formula-empty">
          <span aria-hidden="true">{favoritesOnly && !favorites.length ? '☆' : '⌕'}</span>
          <h3>{favoritesOnly && !favorites.length ? '还没有收藏的公式' : '没有找到匹配的公式'}</h3>
          <p>
            {favoritesOnly && !favorites.length
              ? '打开任意公式，点击“收藏”，以后就能从这里快速找到。'
              : '试试较短的关键词、英文别名，或清除学科和章节筛选。'}
          </p>
          <button type="button" onClick={clearFilters}>
            浏览全部公式
          </button>
        </div>
      )}
      <footer className="formula-footer">
        <details>
          <summary>如何使用公式速查</summary>
          <p>
            搜索或按学科、章节筛选后，选择一个公式查看完整说明。核对适用条件、符号与单位，再参考例题。
            收藏只保存在当前设备；切换页面会保留本次搜索和选择。内置条目用于学习自查，不代替完整教材。
          </p>
        </details>
        <p>公式库 {FORMULA_CATALOG_VERSION} · 内置离线内容 · 收藏仅限当前设备</p>
      </footer>
    </section>
  )
}
