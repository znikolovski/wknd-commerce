const {
  toProductView, priceRangeFor, priceFor, sellableSkus, stockFor,
} = require('./catalog');
const { productSearch } = require('./search');

const normalize = (text) => String(text).normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const contains = (text, phrase) => ` ${text} `.includes(` ${normalize(phrase)} `);
const SHOPPING = /\b(buy|shop|purchase|products?|compare|comparison|recommend|choose|cheaper|lighter|affordable|budget|gift|gear)\b/i;
const PLANNING = /\b(plan|planning|itinerary|routes?|permits?|pack|packing|prepare|preparation|visit|travel|book)\b/i;
const TRIP = /\b(adventures?|trips?|treks?|trekking|hikes?|hiking|climbs?|climbing|kayaking|surfing|cycling|destinations?)\b/i;
const REFINEMENT = /\b(cheaper|lighter|those|these|ones|instead|under|below|less than|up to)\b/i;
const ALIASES = [
  ['jackets', /\b(jackets?|shells?|parkas?|windbreakers?)\b/i],
  ['packs', /\b(backpacks?|daypacks?|rucksacks?|packs?)\b/i],
  ['base-layers', /\b(base layers?|mid layers?|fleeces?|thermals?)\b/i],
  ['pants', /\b(pants|trousers|shorts|leggings)\b/i],
  ['tees', /\b(tees?|shirts?|tops?)\b/i],
  ['headwear', /\b(hats?|caps?|beanies?|headwear)\b/i],
  ['gloves', /\b(gloves?|mittens?)\b/i],
  ['socks', /\bsocks?\b/i],
  ['duffels', /\b(duffels?|duffles?|travel bags?)\b/i],
  ['packing', /\b(packing cubes?|dry bags?|organisers?|organizers?)\b/i],
  ['hydration', /\b(bottles?|hydration|water filters?|bladders?)\b/i],
  ['lighting', /\b(headlamps?|headlights?|lanterns?|torches?)\b/i],
  ['travel-tech', /\b(power banks?|adapters?|travel tech|chargers?)\b/i],
];
const STOP = new Set(('a an the me my we our i want need please show find suggest recommend compare '
  + 'comparison best good better buy shop shopping purchase products product gear for on of in with '
  + 'and or to than under below less up at most aud dollars budget cheaper lighter lightweight '
  + 'options ones these those waterproof affordable about tell which is are would suitable').split(' '));

function inputError(message) {
  const error = new Error(message);
  error.extensions = { category: 'graphql-input' };
  throw error;
}

function validateInput(query, history) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500) {
    inputError('OF1 query must contain 1–500 characters.');
  }
  if (!Array.isArray(history) || history.length > 5
    || history.some((q) => typeof q !== 'string' || q.length > 500)) {
    inputError('OF1 history must contain at most five queries of up to 500 characters.');
  }
}

function base(experience, heading, explanation = '') {
  return {
    experience, heading, explanation, subject: '', maxPrice: null,
    products: [], adventureSlugs: [], suggestions: [],
  };
}

function clarify(message) {
  return {
    ...base('clarification', 'A little more detail?', message),
    suggestions: [
      { label: 'Compare jackets', query: 'Compare waterproof jackets' },
      { label: 'Plan an adventure', query: 'Plan a Patagonia trek' },
    ],
  };
}

function matchingNames(cat, query) {
  const text = normalize(query);
  return cat.products.filter((p) => contains(text, p.name) || contains(text, p.sku)
    || (p.variants || []).some((v) => contains(text, v.sku)));
}

function categoriesFor(cat, query) {
  const paths = new Set(ALIASES.filter(([, pattern]) => pattern.test(query))
    .map(([category]) => category));
  cat.categories.forEach((c) => {
    if (contains(normalize(query), c.name)) paths.add(c.urlPath.split('/').pop());
  });
  return [...paths];
}

function affordable(cat, product, maxPrice) {
  return sellableSkus(product).some((sku) => {
    const raw = cat.priceBySku.get(sku) || cat.priceBySku.get(product.sku);
    const price = priceFor(cat, sku, product.sku).final;
    return raw && Number.isFinite(raw.regular) && stockFor(cat, sku).inStock
      && (maxPrice == null || price <= maxPrice);
  });
}

function resolve(cat, query, history) {
  const names = matchingNames(cat, query);
  const categories = categoriesFor(cat, query);
  const shopping = SHOPPING.test(query);
  if (/\b(?:first|second|third)\s+(?:one|product)\b|\b(?:that|this) one\b/i.test(query)
    || /^\s*(?:the )?(?:first|second|third)\s*[?!.]*$/i.test(query)) {
    return clarify('Please name the product you mean so I can use its current catalog details.');
  }
  // Preparation questions are not shopping merely because they mention equipment.
  if (PLANNING.test(query) && TRIP.test(query)
    && !/\b(buy|shop|purchase|products?|compare.*(?:jacket|pack|gear))\b/i.test(query)) {
    return base('adventure', '');
  }
  if (!names.length && !categories.length && !shopping && !REFINEMENT.test(query)) {
    if (/^\s*(patagonia|gear|equipment)\s*[?!.]*$/i.test(query)) {
      return clarify('Are you looking for products to buy or an adventure to plan?');
    }
    return base('adventure', '');
  }
  if (TRIP.test(query) && !names.length && !categories.length
    && !/\b(buy|shop|purchase|products?|gear|gift|cheaper|lighter)\b/i.test(query)) {
    return base('adventure', '');
  }
  if (/\b(USD|EUR|GBP)\b|[£€]/i.test(query)) {
    return clarify('WKND prices are in AUD. Please specify your budget in Australian dollars.');
  }

  let prior;
  if (REFINEMENT.test(query) && !names.length && !categories.length && history.length) {
    const [previous, ...rest] = [...history].reverse();
    prior = resolve(cat, previous, rest.reverse());
    if (prior.experience !== 'product' || !prior.subject) {
      return clarify('Which product or category should I refine?');
    }
  }
  const subject = categories[0] || (names.length ? names[0].name : prior?.subject || '');
  const inherited = prior && !categories.length && !names.length;
  let effectiveCategories = categories;
  if (inherited) {
    effectiveCategories = categoriesFor(cat, prior.subject);
    if (!effectiveCategories.length && prior.products.length) {
      effectiveCategories = (cat.bySku.get(prior.products[0].sku)?.categories || [])
        .map((path) => path.split('/').pop());
    }
  }
  const budget = query.match(/\b(under|below|less than|up to|at most)\s*(?:AUD\s*)?\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (/\b(under|below|less than|up to|at most)\b/i.test(query) && (!budget || Number(budget[2]) <= 0)) {
    return clarify('Please give a numeric AUD budget greater than zero, for example jackets under AUD 300.');
  }
  let maxPrice = budget ? Number(budget[2]) - (/under|below|less than/i.test(budget[1]) ? 0.01 : 0)
    : inherited ? prior.maxPrice : null;
  if (/\bcheaper\b/i.test(query) && prior?.products.length) {
    const prices = prior.products.map((view) => {
      const p = cat.bySku.get(view.sku);
      return priceRangeFor(cat, p).min.final;
    });
    maxPrice = Math.min(maxPrice ?? Infinity, ...prices) - 0.01;
  }
  const waterproof = /\bwaterproof\b/i.test(query) || (inherited && /\bwaterproof\b/i.test(prior.explanation));
  let candidates;
  if (names.length) {
    candidates = names;
  } else if (effectiveCategories.length) {
    candidates = cat.products.filter((p) => (p.categories || [])
      .some((path) => effectiveCategories.includes(path.split('/').pop())));
  } else {
    const words = normalize(inherited ? prior.subject : query).split(' ')
      .filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
    if (!words.length) return clarify('What kind of product would you like to compare?');
    const data = productSearch(cat, { phrase: words.join(' '), page_size: 100 });
    candidates = data.items.map((item) => cat.bySku.get(item.productView.sku))
      .filter((p) => words.every((word) => normalize([
        p.name, p.sku, ...p.categories, ...Object.values(p.attributes || {}), ...(p.tags || []),
      ].join(' ')).split(' ').some((term) => term.startsWith(word))));
  }
  const namedUnavailable = names.filter((p) => !affordable(cat, p, maxPrice));
  const priced = (p) => sellableSkus(p).some((sku) => Number.isFinite(
    (cat.priceBySku.get(sku) || cat.priceBySku.get(p.sku))?.regular,
  ));
  candidates = candidates.filter((p) => priced(p) && ((names.length && maxPrice == null) || affordable(cat, p, maxPrice))
    && (!waterproof || p.attributes?.waterproof_rating));
  const destination = cat.products.flatMap((p) => p.tags || [])
    .filter((tag) => tag.includes('-') && normalize(query).includes(normalize(tag).split(' ')[0]));
  const score = (p) => (p.tags || []).reduce((value, tag) => value
    + (destination.includes(tag) ? 4 : 0) + (contains(normalize(query), tag) ? 2 : 0), 0)
    + (p.attributes?.activity && contains(normalize(query), p.attributes.activity) ? 3 : 0);
  candidates.sort((a, b) => {
    if (names.length) return names.indexOf(a) - names.indexOf(b);
    if (/\b(lightweight|lighter|lightest)\b/i.test(query)) {
      return (Number(a.attributes?.weight_g) || Infinity) - (Number(b.attributes?.weight_g) || Infinity);
    }
    if (/\b(cheaper|affordable|budget)\b/i.test(query)) {
      return priceRangeFor(cat, a).min.final - priceRangeFor(cat, b).min.final;
    }
    return score(b) - score(a) || (a.position ?? 999) - (b.position ?? 999);
  });
  const selected = candidates.slice(0, 3);
  const slugs = new Map();
  selected.forEach((p) => (p.tags || []).filter((tag) => /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(tag))
    .forEach((tag) => slugs.set(tag, (slugs.get(tag) || 0) + 1)));
  const explanation = [
    waterproof ? 'Products with a catalogued waterproof rating.' : 'Matches from the current WKND catalog.',
    maxPrice != null ? `Available options up to AUD ${Math.max(0, maxPrice).toFixed(2)}.` : '',
    namedUnavailable.length ? `Not available within these criteria: ${namedUnavailable.map((p) => p.name).join(', ')}.` : '',
    'Compare the published specifications; an association with an adventure is not a safety certification.',
  ].filter(Boolean).join(' ');
  const nextSubject = subject || query;
  return {
    experience: 'product',
    heading: selected.length ? (selected.length === 1 ? 'Your gear match' : 'Compare your WKND gear') : 'No matching gear',
    explanation,
    subject: nextSubject,
    maxPrice,
    products: selected.map((p) => toProductView(cat, p)),
    adventureSlugs: [...slugs].sort((a, b) => b[1] - a[1]).map(([slug]) => slug).slice(0, 30),
    suggestions: [
      { label: 'Browse this gear', query: `Show ${nextSubject}` },
      ...(selected.length ? [{
        label: 'Lighter alternatives', query: `Compare lightweight ${effectiveCategories[0] || nextSubject}`,
      }] : [{ label: 'Try jackets', query: 'Compare waterproof jackets' }]),
      { label: 'Plan an adventure', query: 'Plan a Patagonia trek' },
    ],
  };
}

function discoverProducts(cat, { query, history = [] }) {
  validateInput(query, history);
  // The SDK includes the current query in conversationHistory.
  const previous = [...history];
  if (previous.at(-1) === query) previous.pop();
  return resolve(cat, query.trim(), previous);
}

module.exports = { discoverProducts };
