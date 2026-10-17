/**
 * `session_search` — cross-session recall for the agent.
 *
 * Migrated verbatim from `dsh-plugins/dsh-session-search` (S2). The only edits:
 *
 *   - the standalone `export const name` / `export const inject` are gone (the
 *     container owns activation);
 *   - `apply(ctx)` became `install(ctx)`, and it now RETURNS the disposer from
 *     `ctx.tools.register(...)`. The original discarded that value, which is why
 *     a switch could never remove the tool;
 *   - the container gates it on the `sessionSearch` switch.
 *
 * It stays dependency-free on purpose: a profile-installed bundle cannot resolve
 * packages shipped inside the harness installation, and `ctx.tools.register`
 * only needs plain JSON Schema for `parameters` and `output.schema`.
 */
/**
 * `session_search` — cross-session recall for the agent.
 *
 * Three modes, mirroring the shapes a recall tool actually needs:
 *   - read:   an explicit `sessionId` returns that session's model surface as text.
 *   - search: a `query` returns the sessions whose events match it, best match first.
 *   - browse: neither argument lists the newest sessions.
 *
 * Search prefers the composed full-text backend (`searchSessions`) and falls back to
 * the backend-independent literal scan (`listSessions` + `filterEvents`) when no
 * backend is mounted or the search fails, so the tool works either way.
 *
 * Two deliberate quality choices, learned from a noisy first run:
 *   1. Only CONVERSATION messages are searched (`user/message` + `assistant/message`).
 *      Tool results are excluded: a workspace full of files named after a topic makes
 *      every directory listing match that topic, which drowns the real hits.
 *   2. Excerpts are centered on the match, not on the start of the document — the
 *      literal scan returns the whole extracted text, so showing its head hid the
 *      very match that qualified the session.
 *
 * Deliberately dependency-free: `ctx.tools.register` stores the definition as-is and
 * requires only that `parameters` and `output.schema` are plain JSON Schema, so this
 * bundle never imports `@deepseek-ai/dsh-tools` (a profile-installed bundle cannot
 * resolve packages shipped inside the harness installation).
 */

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const READ_MAX_MESSAGES = 60
const READ_MAX_CHARS = 1200
const SNIPPET_CHARS = 300

/** Event types that carry the actual conversation; tool results are noise. */
const CONVERSATION_TYPES = ['user/message', 'assistant/message']
const CONVERSATION_FILTER = { kind: 'type', values: CONVERSATION_TYPES }

function clampLimit(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : DEFAULT_LIMIT
  return Math.min(Math.max(n, 1), MAX_LIMIT)
}

function blockText(block) {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  if (typeof block.text === 'string') return block.text
  if (Array.isArray(block.content)) return block.content.map(blockText).join('')
  return ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockText).join('').trim()
  if (content && typeof content === 'object') return blockText(content)
  return ''
}

function eventText(event) {
  const data = (event && event.data) || {}
  switch (event && event.type) {
    case 'user/message':
    case 'developer/message':
      return contentText(data.content !== undefined ? data.content : data.message && data.message.content)
    case 'assistant/message':
      return contentText(data.message && data.message.content !== undefined ? data.message.content : data.content)
    case 'tool/result':
      return contentText(data.message && data.message.content !== undefined ? data.message.content : data.content)
    default:
      return ''
  }
}

function roleOf(type) {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  return 'other'
}

function isoTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().replace('T', ' ').slice(0, 16)
}

function flatten(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
}

function clip(text, max) {
  const s = flatten(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Excerpt centered on the first occurrence of `query`, so a long message shows the
 * part that actually matched instead of its opening line.
 */
function snippetAround(text, query, max) {
  const s = flatten(text)
  if (s.length <= max) return s
  const needle = flatten(query).toLowerCase()
  const idx = needle ? s.toLowerCase().indexOf(needle) : -1
  if (idx <= 0) return s.slice(0, max) + '…'
  const start = Math.max(0, idx - Math.floor(max / 3))
  const end = Math.min(s.length, start + max)
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '')
}

async function titlesFor(sq, ids) {
  const out = new Map()
  if (!ids.length) return out
  try {
    const results = await sq.readTitleSnapshots(ids)
    for (const r of results || []) {
      if (r && r.status === 'fulfilled' && r.value && r.value.title && r.value.title.title) {
        out.set(String(r.sessionId), String(r.value.title.title))
      }
    }
  } catch {
    /* titles are best-effort */
  }
  return out
}

function toRow(header, live, title, snippet, matches) {
  return {
    sessionId: String(header.id),
    title: title || '',
    time: isoTime(header.createdAt),
    cwd: header.cwd || '',
    live: Boolean(live),
    snippet: snippet || '',
    matches: matches || 0
  }
}

async function searchViaBackend(sq, query, limit, signal) {
  const page = await sq.searchSessions(
    { query, limit, eventFilters: [CONVERSATION_FILTER] },
    { signal }
  )
  const items = (page && page.items) || []
  const titles = await titlesFor(sq, items.map((h) => h.header.id))
  return items.map((h) =>
    toRow(
      h.header,
      h.live,
      titles.get(String(h.header.id)),
      clip(h.bestMatch && h.bestMatch.snippet, SNIPPET_CHARS),
      1
    )
  )
}

async function searchViaScan(sq, query, limit, signal) {
  const sessions = await sq.listSessions(signal)
  const rows = []
  for (const rec of sessions || []) {
    if (rows.length >= limit) break
    let docs = []
    try {
      docs = await sq.filterEvents(rec.header.id, [CONVERSATION_FILTER, { kind: 'text', text: query }])
    } catch {
      continue
    }
    if (!docs || !docs.length) continue
    rows.push(
      toRow(rec.header, rec.live, '', snippetAround(docs[0].text, query, SNIPPET_CHARS), docs.length)
    )
  }
  const titles = await titlesFor(sq, rows.map((r) => r.sessionId))
  for (const row of rows) row.title = titles.get(row.sessionId) || ''
  return rows
}

async function browseSessions(sq, limit, signal) {
  const sessions = await sq.listSessions(signal)
  const slice = (sessions || []).slice(0, limit)
  const titles = await titlesFor(sq, slice.map((r) => r.header.id))
  return slice.map((r) => toRow(r.header, r.live, titles.get(String(r.header.id)), '', 0))
}

async function readOne(sq, sessionId) {
  const snap = await sq.readSurface(sessionId)
  const lines = []
  for (const ev of snap.events || []) {
    const text = eventText(ev)
    if (!text) continue
    lines.push(`[${roleOf(ev.type)}] ${clip(text, READ_MAX_CHARS)}`)
    if (lines.length >= READ_MAX_MESSAGES) break
  }
  return { session: snap.session, lines }
}

function renderValue(value) {
  if (!value) return 'No result.'
  if (value.mode === 'read') {
    const head = `Session ${value.sessionId} · ${value.time || 'unknown time'}${value.cwd ? ' · ' + value.cwd : ''}`
    if (!value.content || !value.content.length) return `${head}\n(no readable messages)`
    return `${head}\n\n${value.content.join('\n')}`
  }
  const label =
    value.mode === 'search'
      ? `Search "${value.query}"${value.viaBackend ? '' : ' (literal scan fallback)'}`
      : 'Recent sessions'
  if (!value.results || !value.results.length) return `${label}\nNo matching sessions.`
  const body = value.results
    .map((r) => {
      const bits = [r.time || '?', r.title ? `"${r.title}"` : '(untitled)', r.live ? 'live' : 'persisted']
      const line = `- ${r.sessionId} · ${bits.join(' · ')}${r.cwd ? ' · ' + r.cwd : ''}`
      return r.snippet ? `${line}\n  ${r.snippet}` : line
    })
    .join('\n')
  return `${label} — ${value.results.length} session(s)\n${body}`
}

const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Full-text query over past sessions. Distinctive words work best: it is matched as tokenized phrases, not an arbitrary substring. Only conversation messages are searched, not tool output.'
    },
    sessionId: {
      type: 'string',
      description: 'Read this exact session id (as returned by a search or browse call) instead of searching.'
    },
    limit: {
      type: 'integer',
      description: `Maximum sessions to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`
    }
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['search', 'browse', 'read'] },
    query: { type: 'string' },
    viaBackend: { type: 'boolean' },
    sessionId: { type: 'string' },
    time: { type: 'string' },
    cwd: { type: 'string' },
    total: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          time: { type: 'string' },
          cwd: { type: 'string' },
          live: { type: 'boolean' },
          snippet: { type: 'string' },
          matches: { type: 'integer' }
        }
      }
    },
    content: { type: 'array', items: { type: 'string' } }
  }
}

/**
 * Read an OPTIONAL service without tripping Cordis's inject guard.
 *
 * `ctx.sessionQuery` throws `cannot get property "sessionQuery" without inject`
 * when the name is not in the module's `inject` list — and adding it there would
 * stop the whole toolbox from activating in a profile that lacks it. `ctx.get()`
 * answers `undefined` instead, which the caller turns into a clean no-op.
 */
function serviceOf(ctx, name) {
  if (!ctx) return undefined
  // A real Cordis context answers through ctx.get(); a plain test double only
  // carries the property. Both are wrapped, because the property read is exactly
  // what throws on a Cordis context without the matching inject.
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined) return viaGet
    }
  } catch (error) {
    /* fall through to the property read */
  }
  try {
    return ctx[name]
  } catch (error) {
    return undefined
  }
}
export function install(ctx) {
  // The container activates this without a module-level `inject`, so every
  // dependency is checked here: a minimal profile must not crash the toolbox.
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    console.warn('[dsh-toolbox] session_search: the tools service is unavailable')
    return () => {}
  }
  const sessionQuery = serviceOf(ctx, 'sessionQuery')
  if (!sessionQuery) {
    console.warn('[dsh-toolbox] session_search: sessionQuery is unavailable in this profile')
    return () => {}
  }

  return ctx.tools.register({
    name: 'session_search',
    description:
      'Search and read past sessions (every conversation ever stored, not just this one). ' +
      'Use it to answer "what did we discuss before?" instead of guessing, whenever the user refers to earlier ' +
      'work, an earlier decision, or a fact they expect you to already know.\n\n' +
      'MODES: pass `query` to search every session and get the best-matching sessions with excerpts; ' +
      'pass `sessionId` to read one session\'s messages as text; pass neither to browse the newest sessions. ' +
      'Only conversation messages are searched (tool output is excluded), and the query is matched as a phrase ' +
      'of tokens rather than an arbitrary substring, so prefer distinctive words. ' +
      'When no full-text backend is mounted the tool transparently falls back to a literal scan.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }]
    },
    async execute(args, exec) {
      const sq = sessionQuery
      const signal = exec && exec.signal
      const limit = clampLimit(args && args.limit)

      if (args && args.sessionId) {
        const { session, lines } = await readOne(sq, String(args.sessionId))
        return {
          mode: 'read',
          sessionId: String(session.id),
          time: isoTime(session.createdAt),
          cwd: session.cwd || '',
          total: lines.length,
          results: [],
          content: lines
        }
      }

      if (args && args.query) {
        const query = String(args.query)
        let viaBackend = true
        let results
        try {
          results = await searchViaBackend(sq, query, limit, signal)
        } catch {
          viaBackend = false
          results = await searchViaScan(sq, query, limit, signal)
        }
        return { mode: 'search', query, viaBackend, total: results.length, results, content: [] }
      }

      const results = await browseSessions(sq, limit, signal)
      return { mode: 'browse', total: results.length, results, content: [] }
    },
    presentCall: (args) => ({
      card: 'generic',
      title:
        args && args.sessionId
          ? 'Read a past session'
          : args && args.query
            ? `Search past sessions: ${args.query}`
            : 'Browse past sessions',
      kind: 'search'
    })
  })
}



