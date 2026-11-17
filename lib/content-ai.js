/**
 * Request builders and response shaping for the AEM Content AI (stable) search API.
 */
const MAX_QUERY = 300;
const MAX_LIMIT = 20;
// Crawled infrastructure pages (OF1 knowledge/config, fragments, drafts, nav) are not search results.
const INTERNAL_PATH = /^\/(of1\/(config|knowledge)|fragments|drafts|tools|nav|footer|placeholders)(\/|$)/;
const NO_ANSWER = /^\s*(no relevant information found\.?|i am designed to prioriti[sz]e user safety)/i;

function searchBody(input = {}, source) {
  const text = String(input.query?.text ?? input.query ?? '').slice(0, MAX_QUERY).trim();
  if (!text) return null;
  const type = ['vector', 'fulltext', 'hybrid'].includes(input.query?.type) ? input.query.type : 'vector';
  const limit = Math.min(Number(input.queryOptions?.pagination?.limit) || 8, MAX_LIMIT);
  const cursor = input.queryOptions?.pagination?.cursor;
  return {
    contentSource: { name: source },
    query: { type, text, options: {} },
    queryOptions: { pagination: { limit, ...(cursor ? { cursor: String(cursor).slice(0, 500) } : {}) } },
  };
}

function genBody(input = {}, source) {
  const query = String(input.query ?? '').slice(0, MAX_QUERY * 4).trim();
  return query.length >= 3 ? { query, contentSource: { name: source } } : null;
}

function sitePath(url, siteOrigin) {
  try {
    const u = new URL(url, siteOrigin || 'https://wknd-adventures.run.place');
    if (siteOrigin && u.origin !== new URL(siteOrigin).origin) return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

function snippet(text = '', max = 220) {
  const body = String(text)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l) && l.length > 40)
    .join(' ');
  return body.length > max ? `${body.slice(0, max).replace(/\s+\S*$/, '')}…` : body;
}

function toHit(raw = {}, siteOrigin) {
  const data = raw.data || {};
  const meta = data.metadata || {};
  const url = meta.canonical_url || meta.meta?.url || meta.source || data.source || '';
  const path = sitePath(url, siteOrigin);
  if (!path || INTERNAL_PATH.test(path)) return null;
  const image = meta.meta?.image ? sitePath(meta.meta.image, siteOrigin) : null;
  return {
    id: raw.id,
    score: typeof raw.score === 'number' ? Math.round(raw.score * 1000) / 1000 : undefined,
    path,
    title: String(meta.title || '').replace(/\s+[—|-]\s+WKND Adventures$/, ''),
    description: meta.description || '',
    section: meta.structured?.headings?.context?.replace(/^Section:\s*/, '') || '',
    image,
    snippet: snippet(data.text),
  };
}

// Content AI returns one hit per chunk; keep the best-scoring chunk per page.
function dedupeByPath(hits) {
  const seen = new Map();
  hits.filter(Boolean).forEach((h) => {
    if (!seen.has(h.path) || (h.score ?? 0) > (seen.get(h.path).score ?? 0)) seen.set(h.path, h);
  });
  return [...seen.values()];
}

function toSearchResponse(json = {}, siteOrigin) {
  const results = dedupeByPath((json.results || []).map((r) => toHit(r, siteOrigin)));
  return { totalResults: json.totalResults ?? results.length, cursor: json.cursor || null, results };
}

function toGenResponse(json = {}, siteOrigin) {
  const answer = String(json.result || '').trim();
  const hits = dedupeByPath((json.hits || []).map((r) => toHit(r, siteOrigin)));
  return {
    query: json.query,
    grounded: Boolean(answer) && !NO_ANSWER.test(answer),
    answer,
    hits,
  };
}

module.exports = {
  searchBody, genBody, toSearchResponse, toGenResponse, toHit, snippet,
};
