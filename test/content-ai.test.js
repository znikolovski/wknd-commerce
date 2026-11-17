const {
  searchBody, genBody, toSearchResponse, toGenResponse,
} = require('../lib/content-ai');

const ORIGIN = 'https://wknd-adventures.run.place';
const hit = (id, path, score, extra = {}) => ({
  id,
  score,
  data: {
    text: `Title\n\n# Heading\n\n${'Plan your first trek with honest numbers and a realistic daily distance. '.repeat(3)}[Browse](https://x)`,
    metadata: {
      canonical_url: `${ORIGIN}${path}`,
      title: `Page ${id} — WKND Adventures`,
      description: `Description ${id}`,
      structured: { headings: { context: 'Section: Plan your first trek' } },
      meta: { image: `${ORIGIN}/media_abc.avif?width=1200` },
      ...extra,
    },
  },
});

describe('content-ai request builders', () => {
  test('search pins the source, always sends options and clamps limit', () => {
    const body = searchBody({ query: { text: '  trek  ', type: 'evil' }, queryOptions: { pagination: { limit: 99, cursor: 'c' } } }, 'wknd-adventures');
    expect(body).toEqual({
      contentSource: { name: 'wknd-adventures' },
      query: { type: 'vector', text: 'trek', options: {} },
      queryOptions: { pagination: { limit: 20, cursor: 'c' } },
    });
    expect(searchBody({ query: '' }, 's')).toBeNull();
  });

  test('gensearch requires 3+ characters', () => {
    expect(genBody({ query: 'hi' }, 's')).toBeNull();
    expect(genBody({ query: 'what to pack' }, 's')).toEqual({ query: 'what to pack', contentSource: { name: 's' } });
  });
});

describe('content-ai response shaping', () => {
  test('search hits are compacted, site-relative and deduped per page', () => {
    const out = toSearchResponse({
      totalResults: 3,
      cursor: 'next',
      results: [hit('a', '/multi-day-trekking', 0.5), hit('b', '/multi-day-trekking', 0.8), hit('c', '/gear', 0.6), hit('d', 'https://evil.example/x', 0.9), hit('e', '/of1/knowledge/auto-blog-1', 0.95), hit('f', '/of1/config/knowledge', 0.9)],
    }, ORIGIN);
    expect(out.cursor).toBe('next');
    expect(out.results.map((r) => r.path)).toEqual(['/multi-day-trekking', '/gear']);
    expect(out.results[0]).toMatchObject({
      id: 'b', title: 'Page b', section: 'Plan your first trek', image: '/media_abc.avif?width=1200',
    });
    expect(out.results[0].snippet).toMatch(/^Plan your first trek/);
    expect(out.results[0].snippet.length).toBeLessThanOrEqual(221);
    expect(JSON.stringify(out)).not.toMatch(/structured|canonical_url/);
  });

  test('ungrounded generative answers are flagged', () => {
    expect(toGenResponse({ query: 'q', result: 'No relevant information found.', hits: [] }, ORIGIN).grounded).toBe(false);
    expect(toGenResponse({ query: 'q', result: 'I am designed to prioritize user safety, privacy…', hits: [] }, ORIGIN).grounded).toBe(false);
    const ok = toGenResponse({ query: 'q', result: 'Plan 10–15 km a day.', hits: [hit('a', '/multi-day-trekking', 0.7)] }, ORIGIN);
    expect(ok).toMatchObject({ grounded: true, answer: 'Plan 10–15 km a day.' });
    expect(ok.hits[0].path).toBe('/multi-day-trekking');
  });
});

describe('CORS origin matching', () => {
  const { corsHeaders } = require('../lib/http');
  const params = { ALLOWED_ORIGINS: 'https://wknd-adventures.run.place,https://*--masterclass-demo--znikolovski.aem.page' };
  test('allows branch previews by wildcard and rejects others', () => {
    expect(corsHeaders(params, 'https://shop-storefront--masterclass-demo--znikolovski.aem.page')['Access-Control-Allow-Origin'])
      .toBe('https://shop-storefront--masterclass-demo--znikolovski.aem.page');
    expect(corsHeaders(params, 'https://evil.example')['Access-Control-Allow-Origin']).toBe('https://wknd-adventures.run.place');
    expect(corsHeaders(params, 'https://x.y--masterclass-demo--znikolovski.aem.page')['Access-Control-Allow-Origin']).toBe('https://wknd-adventures.run.place');
  });
});
