/**
 * WKND Adventures shop catalog source (apparel + travel accessories).
 * scripts/generate-catalog.mjs expands this into products/variants/prices/inventory.
 *
 * Row: [name, category, priceAUD, adventureTags, attributes, optionsKey, extra]
 * Adventure tags use the site's adventureCategory values plus adventure slugs
 * (tools/adventures/adventure-catalog-enrichment.json in masterclass-demo).
 */

export const CATEGORIES = [
  { urlPath: 'apparel', name: 'Apparel', position: 1, description: 'Technical layers and everyday trail wear, designed in Sydney and field-tested on WKND expeditions.' },
  { urlPath: 'apparel/jackets', parent: 'apparel', name: 'Jackets', position: 1, description: 'Shells, insulation and wind layers for every forecast.' },
  { urlPath: 'apparel/base-layers', parent: 'apparel', name: 'Base & Mid Layers', position: 2, description: 'Merino and fleece that regulate temperature from first light to summit.' },
  { urlPath: 'apparel/pants', parent: 'apparel', name: 'Pants & Shorts', position: 3, description: 'Hard-wearing legwear that moves the way you do.' },
  { urlPath: 'apparel/tees', parent: 'apparel', name: 'Tees & Tops', position: 4, description: 'Organic cotton and quick-dry tops for basecamp and beyond.' },
  { urlPath: 'apparel/headwear', parent: 'apparel', name: 'Headwear', position: 5, description: 'Caps, beanies and sun protection.' },
  { urlPath: 'apparel/gloves', parent: 'apparel', name: 'Gloves', position: 6, description: 'Dexterity and warmth for cold starts and rough rock.' },
  { urlPath: 'apparel/socks', parent: 'apparel', name: 'Socks', position: 7, description: 'Merino socks engineered for long days on foot.' },
  { urlPath: 'accessories', name: 'Travel Accessories', position: 2, description: 'Packs, organisation and travel tech for getting there and back.' },
  { urlPath: 'accessories/packs', parent: 'accessories', name: 'Backpacks', position: 1, description: 'Daypacks to expedition haulers.' },
  { urlPath: 'accessories/duffels', parent: 'accessories', name: 'Duffels & Travel Bags', position: 2, description: 'Bombproof bags for planes, boats and pack mules.' },
  { urlPath: 'accessories/packing', parent: 'accessories', name: 'Packing & Organisation', position: 3, description: 'Cubes, dry bags and kits that keep chaos contained.' },
  { urlPath: 'accessories/hydration', parent: 'accessories', name: 'Hydration', position: 4, description: 'Bottles, filters and bladders for clean water anywhere.' },
  { urlPath: 'accessories/lighting', parent: 'accessories', name: 'Lighting', position: 5, description: 'Headlamps and lanterns for alpine starts and camp nights.' },
  { urlPath: 'accessories/travel-tech', parent: 'accessories', name: 'Travel Tech & Essentials', position: 6, description: 'Power, protection and comfort for long-haul travel.' },
];

const C = {
  ember: { id: 'ember', title: 'Ember Red', swatch: '#C1440E' },
  glacier: { id: 'glacier', title: 'Glacier Blue', swatch: '#4A7FA7' },
  basalt: { id: 'basalt', title: 'Basalt Black', swatch: '#26282B' },
  moss: { id: 'moss', title: 'Moss Green', swatch: '#5B6B3A' },
  sand: { id: 'sand', title: 'Desert Sand', swatch: '#C9AE84' },
  slate: { id: 'slate', title: 'Slate Grey', swatch: '#6B7279' },
  saffron: { id: 'saffron', title: 'Saffron', swatch: '#E5A823' },
  ocean: { id: 'ocean', title: 'Deep Ocean', swatch: '#1F4E66' },
  chalk: { id: 'chalk', title: 'Chalk White', swatch: '#EDEBE6' },
};

const SIZES = ['XS', 'S', 'M', 'L', 'XL'].map((s) => ({ id: s.toLowerCase(), title: s }));
const SIZES_SM = ['S', 'M', 'L', 'XL'].map((s) => ({ id: s.toLowerCase(), title: s }));
const SIZES_SML = ['S/M', 'L/XL'].map((s) => ({ id: s.replace('/', '').toLowerCase(), title: s }));
const SOCK_SIZES = [['s', 'S (AU 4–7)'], ['m', 'M (AU 7–10)'], ['l', 'L (AU 10–13)']].map(([id, title]) => ({ id, title }));

const color = (...keys) => ({ id: 'color', title: 'Colour', values: keys.map((k) => C[k]) });
const size = (values) => ({ id: 'size', title: 'Size', values });
const capacity = (...litres) => ({ id: 'capacity', title: 'Capacity', values: litres.map((l) => ({ id: `${l}l`, title: `${l} L` })) });

export const OPTION_SETS = {
  shell: [color('ember', 'glacier', 'basalt'), size(SIZES)],
  layer: [color('moss', 'slate', 'basalt'), size(SIZES)],
  warm: [color('saffron', 'ocean', 'basalt'), size(SIZES)],
  desert: [color('sand', 'chalk', 'slate'), size(SIZES)],
  water: [color('ocean', 'glacier', 'chalk'), size(SIZES)],
  pants: [color('basalt', 'moss', 'sand'), size(SIZES_SM)],
  tee: [color('chalk', 'basalt', 'moss'), size(SIZES)],
  hat: [color('basalt', 'moss', 'sand')],
  beanie: [color('ember', 'saffron', 'slate')],
  glove: [color('basalt'), size(SIZES_SML)],
  sock: [color('slate', 'moss'), size(SOCK_SIZES)],
  packColor: [color('ember', 'basalt', 'moss')],
  duffel: [color('ember', 'basalt'), capacity(40, 70, 100)],
  bottle: [color('glacier', 'saffron', 'basalt')],
};

const T = {
  trek: ['trekking', 'patagonia-trek', 'coastal-hiking', 'ultralight-backpacking', 'ladakh-india'],
  climb: ['climbing', 'yosemite-rock-climbing'],
  water: ['water', 'kayaking-norway', 'surfing-costa-rica', 'wild-swimming-guide', 'mekong-delta-vietnam'],
  cycle: ['cycling', 'alpine-cycling'],
  alpine: ['winter-alpine', 'winter-mountaineering'],
  desert: ['desert', 'desert-survival-guide'],
  photo: ['photography', 'mountain-photography'],
  travel: ['general-outdoor', 'ohrid-north-macedonia'],
};
const tags = (...keys) => [...new Set(keys.flatMap((k) => T[k]))];

/* eslint-disable max-len */
export const PRODUCTS = [
  // ---------- Jackets ----------
  ['Alpine Shell Jacket', 'apparel/jackets', 449, tags('trek', 'alpine'), { material: '3-layer recycled nylon, 20K/20K membrane', activity: 'Trekking', gender: 'Unisex', weight_g: 410, waterproof_rating: '20,000 mm' }, 'shell', { featured: true, features: ['Fully taped seams and storm hood that fits over a helmet', 'Pit zips for venting on steep climbs', 'Packs into its own chest pocket'] }],
  ['Ridgeline Down Jacket', 'apparel/jackets', 379, tags('alpine', 'photo', 'trek'), { material: '800-fill RDS-certified down', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 360 }, 'warm', { features: ['Hydrophobic down stays warm when damp', 'Baffled hood and adjustable hem', 'Two zipped hand-warmer pockets'] }],
  ['Torrent Rain Jacket', 'apparel/jackets', 249, tags('trek', 'cycle', 'water'), { material: '2.5-layer recycled polyester', activity: 'Hiking', gender: 'Unisex', weight_g: 290, waterproof_rating: '15,000 mm' }, 'water', { features: ['Lightweight waterproof protection for unsettled days', 'Laminated peak keeps rain off your glasses', 'Stuffs into its own pocket'] }],
  ['Windline Softshell', 'apparel/jackets', 229, tags('climb', 'cycle'), { material: 'Stretch woven softshell with DWR', activity: 'Climbing', gender: 'Unisex', weight_g: 330 }, 'layer', { features: ['Four-way stretch for full range of motion', 'Wind-resistant and highly breathable', 'Harness-compatible pockets'] }],
  ['Patagonia Storm Parka', 'apparel/jackets', 529, tags('trek', 'alpine'), { material: '3-layer shell with synthetic insulation', activity: 'Expedition', gender: 'Unisex', weight_g: 720, waterproof_rating: '25,000 mm' }, 'shell', { featured: true, features: ['Built for the relentless winds of the Torres del Paine circuit', 'Insulated, waterproof and fully seam-sealed', 'Two-way zip and oversized chest pockets'] }],
  ['Coastline Windbreaker', 'apparel/jackets', 149, tags('water', 'trek'), { material: 'Ripstop recycled nylon', activity: 'Coastal walking', gender: 'Unisex', weight_g: 140 }, 'water', { features: ['Featherweight wind protection that packs to fist-size', 'Mesh-backed vents', 'Reflective trims for dusk walks'] }],
  ['Summit Belay Parka', 'apparel/jackets', 469, tags('climb', 'alpine'), { material: 'PrimaLoft Gold Active insulation', activity: 'Climbing', gender: 'Unisex', weight_g: 640 }, 'warm', { features: ['Throw-over warmth at cold belays', 'Helmet-compatible hood', 'Two-way zip for belay device access'] }],
  ['Dune Sun Hoodie', 'apparel/jackets', 119, tags('desert', 'water'), { material: 'UPF 50+ recycled polyester knit', activity: 'Desert', gender: 'Unisex', weight_g: 190 }, 'desert', { features: ['UPF 50+ sun protection with thumb loops', 'Scuba-style hood shields neck and ears', 'Wicks fast and dries in minutes'] }],

  // ---------- Base & mid layers ----------
  ['Merino 150 Crew', 'apparel/base-layers', 119, tags('trek', 'travel'), { material: '100% New Zealand merino, 150 gsm', activity: 'Trekking', gender: 'Unisex', weight_g: 150 }, 'layer', { featured: true, features: ['Naturally odour-resistant for multi-day trips', 'Flatlock seams that won\'t rub under a pack', 'Soft enough for the flight home'] }],
  ['Merino 250 Zip Neck', 'apparel/base-layers', 149, tags('alpine', 'trek'), { material: '100% merino, 250 gsm', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 260 }, 'warm', { features: ['Heavyweight merino for cold starts', 'Deep zip for venting', 'Extended cuffs with thumb loops'] }],
  ['Thermal Merino Leggings', 'apparel/base-layers', 109, tags('alpine', 'trek'), { material: 'Merino-nylon core spun, 200 gsm', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 180 }, 'layer', { features: ['Durable core-spun merino', 'Gusseted fit for high steps', 'Wide, flat waistband'] }],
  ['Grid Fleece Hoodie', 'apparel/base-layers', 159, tags('climb', 'trek', 'alpine'), { material: 'Recycled grid fleece', activity: 'Climbing', gender: 'Unisex', weight_g: 300 }, 'warm', { features: ['Grid fleece traps warmth and dumps moisture', 'Balaclava-style hood', 'Chest pocket for phone or topo'] }],
  ['Quarter-Zip Microfleece', 'apparel/base-layers', 99, tags('trek', 'travel', 'photo'), { material: '100 wt recycled microfleece', activity: 'Hiking', gender: 'Unisex', weight_g: 240 }, 'layer', { features: ['Classic midlayer warmth', 'Stand collar and quarter zip', 'Pills less thanks to anti-pill finish'] }],
  ['Long-Sleeve Sun Shirt', 'apparel/base-layers', 89, tags('desert', 'water', 'trek'), { material: 'UPF 50 nylon-elastane', activity: 'Desert', gender: 'Unisex', weight_g: 170 }, 'desert', { features: ['Button-front sun shirt with roll-up sleeves', 'Vented back yoke', 'Hidden zip security pocket'] }],
  ['Merino Boxer Brief', 'apparel/base-layers', 45, tags('trek', 'travel', 'cycle'), { material: 'Merino-Tencel blend', activity: 'Travel', gender: 'Men', weight_g: 70 }, 'layer', { features: ['Breathable, odour-resistant everyday base', 'Anti-chafe flat seams', 'Two-pack value'] }],
  ['Merino Sports Bra', 'apparel/base-layers', 69, tags('trek', 'travel', 'climb'), { material: 'Merino-nylon blend', activity: 'Trekking', gender: 'Women', weight_g: 80 }, 'layer', { features: ['Medium support for trail and wall', 'Removable cups', 'Odour-resistant merino'] }],

  // ---------- Pants ----------
  ['Trailhead Convertible Pants', 'apparel/pants', 139, tags('trek', 'travel', 'desert'), { material: 'Stretch recycled nylon, UPF 40', activity: 'Trekking', gender: 'Unisex', weight_g: 340 }, 'pants', { features: ['Zip-off legs convert to shorts', 'Five pockets including zipped thigh pocket', 'Quick-drying and water-repellent'] }],
  ['Crag Climbing Pants', 'apparel/pants', 129, tags('climb'), { material: 'Organic cotton canvas with stretch', activity: 'Climbing', gender: 'Unisex', weight_g: 420 }, 'pants', { features: ['Gusseted crotch for high steps', 'Drawcord cuffs stay put over shoes', 'Chalk-bag loop'] }],
  ['Storm Overtrousers', 'apparel/pants', 189, tags('trek', 'alpine', 'cycle'), { material: '2.5-layer waterproof', activity: 'Hiking', gender: 'Unisex', weight_g: 260, waterproof_rating: '15,000 mm' }, 'pants', { features: ['Full-length side zips go on over boots', 'Fully taped seams', 'Packs into rear pocket'] }],
  ['Ride Padded Shorts', 'apparel/pants', 119, tags('cycle'), { material: 'Lycra with gel chamois', activity: 'Cycling', gender: 'Unisex', weight_g: 180 }, 'pants', { features: ['Multi-density chamois for long days in the saddle', 'Silicone leg grippers', 'Reflective details'] }],
  ['Desert Explorer Trousers', 'apparel/pants', 149, tags('desert', 'travel'), { material: 'Lightweight cotton-nylon twill', activity: 'Desert', gender: 'Unisex', weight_g: 310 }, 'pants', { features: ['Breathable, sand-shedding weave', 'Roll-up tabs', 'Insect-shield treatment'] }],
  ['Riptide Board Shorts', 'apparel/pants', 79, tags('water'), { material: 'Recycled polyester stretch', activity: 'Water', gender: 'Unisex', weight_g: 160 }, 'pants', { features: ['Four-way stretch for paddling and surfing', 'Drains fast with mesh-free design', 'Key loop pocket'] }],
  ['Approach Hiking Shorts', 'apparel/pants', 89, tags('trek', 'climb'), { material: 'Stretch ripstop', activity: 'Hiking', gender: 'Unisex', weight_g: 200 }, 'pants', { features: ['7-inch inseam with stretch', 'Integrated belt', 'Secure zip back pocket'] }],

  // ---------- Tees ----------
  ['WKND Logo Organic Tee', 'apparel/tees', 49, tags('travel'), { material: '100% organic cotton', activity: 'Everyday', gender: 'Unisex', weight_g: 180 }, 'tee', { featured: true, features: ['Heavyweight organic cotton', 'Water-based WKND print', 'Made in a Fair Trade certified factory'] }],
  ['Trail Running Tee', 'apparel/tees', 59, tags('trek', 'cycle'), { material: 'Recycled polyester mesh', activity: 'Trail running', gender: 'Unisex', weight_g: 110 }, 'layer', { features: ['Ultralight and highly breathable', 'Reflective logo', 'Odour control finish'] }],
  ['Summit Graphic Tee', 'apparel/tees', 49, tags('climb', 'alpine', 'travel'), { material: 'Organic cotton', activity: 'Everyday', gender: 'Unisex', weight_g: 180 }, 'tee', { features: ['Hand-drawn summit graphic', 'Relaxed fit', 'Pre-shrunk'] }],
  ['UPF50 Rash Guard', 'apparel/tees', 79, tags('water'), { material: 'Recycled nylon-elastane, UPF 50+', activity: 'Water', gender: 'Unisex', weight_g: 150 }, 'water', { features: ['Sun and board-rash protection', 'Flatlock seams', 'Chlorine and salt resistant'] }],
  ['Basecamp Henley', 'apparel/tees', 79, tags('travel', 'photo'), { material: 'Organic cotton waffle', activity: 'Basecamp', gender: 'Unisex', weight_g: 240 }, 'tee', { features: ['Soft waffle knit for cool evenings', 'Three-button placket', 'Garment dyed'] }],
  ['Field Notes Long-Sleeve Tee', 'apparel/tees', 59, tags('photo', 'travel', 'trek'), { material: 'Organic cotton', activity: 'Everyday', gender: 'Unisex', weight_g: 200 }, 'tee', { features: ['Sleeve print from WKND Field Notes', 'Rib-knit cuffs', 'Classic fit'] }],

  // ---------- Headwear ----------
  ['Trail Cap', 'apparel/headwear', 39, tags('trek', 'desert', 'cycle'), { material: 'Recycled nylon, quick-dry', activity: 'Hiking', gender: 'Unisex', weight_g: 60 }, 'hat', { features: ['Packable brim', 'Wicking sweatband', 'Adjustable strap'] }],
  ['Merino Beanie', 'apparel/headwear', 45, tags('alpine', 'trek', 'photo'), { material: 'Merino rib knit', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 70 }, 'beanie', { features: ['Double-layer cuff over the ears', 'Itch-free merino', 'Fits under a helmet'] }],
  ['Wide-Brim Sun Hat', 'apparel/headwear', 59, tags('desert', 'water', 'trek'), { material: 'UPF 50 nylon with foam brim', activity: 'Desert', gender: 'Unisex', weight_g: 90 }, 'hat', { features: ['Floating brim for kayak and surf', 'Detachable neck cape', 'Chin cord'] }],
  ['Merino Neck Gaiter', 'apparel/headwear', 35, tags('alpine', 'cycle', 'trek'), { material: 'Lightweight merino', activity: 'All-round', gender: 'Unisex', weight_g: 40 }, 'beanie', { features: ['Wear as neck gaiter, beanie or headband', 'Seamless tube', 'Odour resistant'] }],
  ['Alpine Balaclava', 'apparel/headwear', 49, tags('alpine'), { material: 'Polartec Power Stretch', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 60 }, 'hat', { features: ['Hinged face panel', 'Helmet compatible', 'Breathable mouth mesh'] }],
  ['Reversible Bucket Hat', 'apparel/headwear', 45, tags('water', 'travel'), { material: 'Recycled nylon / organic cotton', activity: 'Water', gender: 'Unisex', weight_g: 70 }, 'hat', { features: ['Two looks in one hat', 'Quick-dry side for the river', 'Packs flat'] }],

  // ---------- Gloves ----------
  ['Merino Liner Gloves', 'apparel/gloves', 39, tags('alpine', 'trek', 'photo'), { material: 'Merino with touchscreen tips', activity: 'All-round', gender: 'Unisex', weight_g: 40 }, 'glove', { features: ['Touchscreen-compatible fingertips', 'Wear alone or under mitts', 'Grippy palm print'] }],
  ['Expedition Alpine Mitts', 'apparel/gloves', 139, tags('alpine'), { material: 'Waterproof shell, PrimaLoft insulation', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 280 }, 'glove', { features: ['Removable liner', 'Leather palm for ice-axe grip', 'Wrist leashes'] }],
  ['Crag Belay Gloves', 'apparel/gloves', 59, tags('climb'), { material: 'Goat leather, reinforced', activity: 'Climbing', gender: 'Unisex', weight_g: 110 }, 'glove', { features: ['Three-quarter fingers for rope handling', 'Reinforced palm and thumb', 'Clip-in loop'] }],
  ['Gravel Cycling Gloves', 'apparel/gloves', 49, tags('cycle'), { material: 'Synthetic leather palm, mesh back', activity: 'Cycling', gender: 'Unisex', weight_g: 60 }, 'glove', { features: ['Gel-padded palm', 'Wipe-friendly thumb', 'Pull-off tabs'] }],

  // ---------- Socks ----------
  ['Merino Hiking Crew Socks', 'apparel/socks', 32, tags('trek'), { material: 'Merino-nylon cushion', activity: 'Trekking', gender: 'Unisex', weight_g: 70 }, 'sock', { featured: true, features: ['Full cushion under foot', 'Seamless toe', 'Lifetime guarantee'] }],
  ['Ultralight Trail Socks', 'apparel/socks', 26, tags('trek', 'cycle'), { material: 'Merino blend, no cushion', activity: 'Trail running', gender: 'Unisex', weight_g: 40 }, 'sock', { features: ['Breathable mesh zones', 'Arch support', 'Quarter height'] }],
  ['Alpine Ski Socks', 'apparel/socks', 39, tags('alpine'), { material: 'Merino with shin padding', activity: 'Winter Alpine', gender: 'Unisex', weight_g: 90 }, 'sock', { features: ['Over-the-calf height', 'Targeted shin padding', 'Moisture wicking'] }],
  ['Blister Liner Socks', 'apparel/socks', 22, tags('trek', 'desert'), { material: 'Coolmax liner', activity: 'Trekking', gender: 'Unisex', weight_g: 30 }, 'sock', { features: ['Reduces friction under hiking socks', 'Fast drying', 'Two-pack'] }],
  ['Compression Travel Socks', 'apparel/socks', 35, tags('travel'), { material: 'Graduated compression nylon', activity: 'Travel', gender: 'Unisex', weight_g: 50 }, 'sock', { features: ['Graduated 15–20 mmHg compression for long-haul flights', 'Cushioned sole', 'Knee height'] }],

  // ---------- Packs ----------
  ['Ridgeline Daypack 22L', 'accessories/packs', 129, tags('trek', 'travel', 'photo'), { capacity_l: 22, material: 'Recycled ripstop with TPU coating', activity: 'Hiking', weight_g: 640 }, 'packColor', { featured: true, features: ['Ventilated back panel', 'Hydration sleeve and hose port', 'Stretch front pocket for layers'] }],
  ['Trek 45 Backpack', 'accessories/packs', 289, tags('trek'), { capacity_l: 45, material: 'Robic nylon', activity: 'Trekking', weight_g: 1420 }, 'packColor', { features: ['Adjustable torso length', 'Floating lid and side access zip', 'Integrated rain cover'] }],
  ['Expedition 65 Backpack', 'accessories/packs', 399, tags('trek', 'alpine'), { capacity_l: 65, material: 'Dyneema-reinforced nylon', activity: 'Expedition', weight_g: 2050 }, 'packColor', { features: ['Load-transfer frame for 25 kg+', 'Ice-axe and crampon attachments', 'Sleeping-bag compartment'] }],
  ['Crag Pack 30L', 'accessories/packs', 179, tags('climb'), { capacity_l: 30, material: 'Abrasion-resistant ballistic nylon', activity: 'Climbing', weight_g: 980 }, 'packColor', { features: ['Full-zip clamshell access', 'Rope strap on lid', 'Tarp doubles as rope bag'] }],
  ['Trail Running Vest 12L', 'accessories/packs', 169, tags('trek', 'cycle'), { capacity_l: 12, material: 'Stretch mesh', activity: 'Trail running', weight_g: 290 }, null, { features: ['Bounce-free stretch fit', 'Two 500 ml soft flasks included', 'Pole holster'] }],
  ['Bikepacking Frame Bag', 'accessories/packs', 119, tags('cycle'), { capacity_l: 5, material: 'Waterproof X-Pac', activity: 'Cycling', weight_g: 210 }, null, { features: ['Fits most medium and large frames', 'Waterproof zips', 'Internal divider'] }],
  ['Summit Camera Pack 25L', 'accessories/packs', 249, tags('photo', 'trek'), { capacity_l: 25, material: 'Weatherproof nylon', activity: 'Photography', weight_g: 1250 }, null, { features: ['Padded camera cube with dividers', 'Side access for fast shots', 'Tripod carry'] }],
  ['Packable Daypack 18L', 'accessories/packs', 59, tags('travel', 'trek', 'water'), { capacity_l: 18, material: 'Silnylon ripstop', activity: 'Travel', weight_g: 120 }, 'packColor', { features: ['Packs into its own pocket', 'Ideal summit or city pack', 'Water-resistant fabric'] }],

  // ---------- Duffels ----------
  ['Basecamp Duffel', 'accessories/duffels', 199, tags('travel', 'trek', 'alpine'), { material: 'TPU-laminated ballistic nylon', activity: 'Expedition', weight_g: 1300 }, 'duffel', { featured: true, features: ['Weatherproof and nearly indestructible', 'Removable backpack straps', 'Lockable D-zip'] }],
  ['Roller Duffel 90L', 'accessories/duffels', 349, tags('travel'), { capacity_l: 90, material: 'Recycled ballistic nylon', activity: 'Travel', weight_g: 3200 }, null, { features: ['Rugged wheels for gravel and cobblestones', 'Internal compression straps', 'Luggage tracker sleeve'] }],
  ['Dry Duffel 50L', 'accessories/duffels', 169, tags('water'), { capacity_l: 50, material: 'Welded TPU', activity: 'Water', weight_g: 1100 }, null, { features: ['Fully waterproof roll-top', 'Lash points for kayak decks', 'Backpack straps'] }],
  ['Carry-On Travel Pack 40L', 'accessories/duffels', 279, tags('travel'), { capacity_l: 40, material: 'Recycled nylon', activity: 'Travel', weight_g: 1450 }, 'packColor', { features: ['Max carry-on size for most airlines', 'Clamshell opening', 'Stowable harness'] }],
  ['Weekender Tote', 'accessories/duffels', 119, tags('travel', 'water'), { capacity_l: 35, material: 'Waxed organic canvas', activity: 'Travel', weight_g: 900 }, null, { features: ['Waxed canvas ages beautifully', 'Shoe compartment', 'Leather handles'] }],

  // ---------- Packing ----------
  ['Packing Cube Set', 'accessories/packing', 69, tags('travel', 'trek'), { material: 'Recycled ripstop with mesh panels', activity: 'Travel' }, 'packColor', { featured: true, features: ['Set of three sizes', 'Double zip compression', 'Labelled grab handles'] }],
  ['Compression Stuff Sacks', 'accessories/packing', 49, tags('trek', 'alpine'), { material: 'Silnylon', activity: 'Trekking' }, null, { features: ['Shrink sleeping bags and jackets by up to 50%', 'Four compression straps', 'Set of two'] }],
  ['Dry Bag Trio', 'accessories/packing', 59, tags('water', 'trek'), { material: '70D waterproof nylon', activity: 'Water' }, null, { features: ['5 L, 10 L and 20 L bags', 'Roll-top closure', 'Colour coded'] }],
  ['Hanging Toiletry Kit', 'accessories/packing', 55, tags('travel', 'trek'), { material: 'Recycled nylon', activity: 'Travel' }, null, { features: ['Hook to hang anywhere', 'Detachable mirror', 'TSA-friendly clear pocket'] }],
  ['RFID Travel Wallet', 'accessories/packing', 49, tags('travel'), { material: 'Recycled nylon with RFID shielding', activity: 'Travel' }, null, { features: ['Holds passport, boarding passes and cards', 'RFID-blocking lining', 'Pen loop'] }],
  ['Washable Shoe Bags', 'accessories/packing', 25, tags('travel', 'trek'), { material: 'Ripstop', activity: 'Travel' }, null, { features: ['Keep muddy boots off clean clothes', 'Breathable vent', 'Set of two'] }],

  // ---------- Hydration ----------
  ['Insulated Bottle 750ml', 'accessories/hydration', 49, tags('trek', 'travel', 'cycle'), { capacity_l: 0.75, material: '18/8 stainless steel', activity: 'Everyday' }, 'bottle', { featured: true, features: ['Keeps drinks cold 24 h / hot 12 h', 'Leak-proof cap', 'Powder-coated grip'] }],
  ['Collapsible Bottle 1L', 'accessories/hydration', 25, tags('trek', 'travel'), { capacity_l: 1, material: 'BPA-free TPU', activity: 'Trekking' }, null, { features: ['Rolls flat when empty', 'Fits standard filters', 'Carabiner loop'] }],
  ['Purifier Filter Bottle', 'accessories/hydration', 79, tags('trek', 'travel', 'desert'), { capacity_l: 0.65, material: 'Hollow-fibre filter', activity: 'Trekking' }, null, { features: ['Removes 99.9999% of bacteria', 'Filters up to 1,500 L', 'Squeeze to drink'] }],
  ['Hydration Bladder 2L', 'accessories/hydration', 45, tags('trek', 'cycle'), { capacity_l: 2, material: 'Antimicrobial TPU', activity: 'Hiking' }, null, { features: ['Wide opening for easy cleaning', 'Bite valve with shut-off', 'Quick-disconnect hose'] }],
  ['Titanium Camp Mug', 'accessories/hydration', 39, tags('trek', 'alpine', 'photo'), { capacity_l: 0.45, material: 'Titanium', activity: 'Camp', weight_g: 70 }, null, { features: ['Ultralight and stove-safe', 'Folding handles', 'Measurement markings'] }],
  ['Electrolyte Tabs (20)', 'accessories/hydration', 15, tags('trek', 'cycle', 'desert'), { material: 'Citrus flavour', activity: 'Endurance' }, null, { features: ['Low sugar hydration for hot days', 'Vegan and gluten free', 'Tube of 20'] }],

  // ---------- Lighting ----------
  ['Alpine Start Headlamp 400', 'accessories/lighting', 69, tags('trek', 'alpine', 'climb'), { material: 'IPX7 waterproof housing', activity: 'All-round', weight_g: 80 }, null, { featured: true, features: ['400 lumens with red night mode', 'USB-C rechargeable', 'Lock mode for packing'] }],
  ['Summit Headlamp 900', 'accessories/lighting', 129, tags('alpine', 'climb'), { material: 'Aluminium housing', activity: 'Winter Alpine', weight_g: 110 }, null, { features: ['900 lumens with reactive lighting', 'Cold-weather battery pack', 'Helmet clips included'] }],
  ['Packable Camp Lantern', 'accessories/lighting', 49, tags('trek', 'water', 'travel'), { material: 'Collapsible silicone', activity: 'Camp', weight_g: 120 }, null, { features: ['Collapses flat', 'Doubles as a power bank', 'Floats'] }],
  ['Solar String Lights', 'accessories/lighting', 45, tags('travel', 'photo'), { material: 'Solar panel + LED', activity: 'Camp', weight_g: 150 }, null, { features: ['5 m of warm white LEDs', 'Charges by day, glows by night', 'Weatherproof'] }],

  // ---------- Travel tech & essentials ----------
  ['Universal Travel Adapter', 'accessories/travel-tech', 49, tags('travel'), { material: 'Fire-retardant PC', activity: 'Travel' }, null, { featured: true, features: ['Works in 150+ countries', '2× USB-C, 2× USB-A', 'Built-in fuse'] }],
  ['Solar Power Bank 20,000', 'accessories/travel-tech', 99, tags('trek', 'travel', 'desert'), { material: 'Rugged rubberised shell', activity: 'Trekking', weight_g: 420 }, null, { features: ['20,000 mAh with 30 W USB-C PD', 'Fold-out solar panel', 'IP67'] }],
  ['Satellite Messenger', 'accessories/travel-tech', 449, tags('trek', 'alpine', 'desert'), { material: 'Impact-resistant housing', activity: 'Expedition', weight_g: 100 }, null, { features: ['Two-way messaging anywhere on earth', 'SOS to 24/7 rescue coordination', 'Subscription required (demo)'] }],
  ['Waterproof Phone Pouch', 'accessories/travel-tech', 29, tags('water'), { material: 'TPU with IPX8 seal', activity: 'Water' }, null, { features: ['Touchscreen-friendly window', 'Floats with lanyard', 'Fits phones up to 6.9"'] }],
  ['Memory Foam Travel Pillow', 'accessories/travel-tech', 45, tags('travel'), { material: 'Memory foam, merino cover', activity: 'Travel' }, null, { features: ['Ergonomic chin support', 'Compresses into its own bag', 'Washable cover'] }],
  ['Quick-Dry Trek Towel', 'accessories/travel-tech', 35, tags('travel', 'water', 'trek'), { material: 'Microfibre suede', activity: 'Travel' }, 'bottle', { features: ['Absorbs 4× its weight', 'Dries fast and packs small', 'Hanging loop'] }],
  ['Carbon Trekking Poles', 'accessories/travel-tech', 199, tags('trek', 'alpine'), { material: 'Carbon fibre, cork grips', activity: 'Trekking', weight_g: 450 }, null, { features: ['Three-section fold for travel', 'Cork grips mould to your hands', 'Snow baskets included'] }],
  ['Polarised Trail Sunglasses', 'accessories/travel-tech', 129, tags('trek', 'water', 'desert', 'alpine'), { material: 'TR90 frame, polarised lenses', activity: 'All-round' }, 'hat', { features: ['Category 3 polarised lenses', 'Grippy nose pads', 'Hard case included'] }],
  ['Wilderness First Aid Kit', 'accessories/travel-tech', 79, tags('trek', 'climb', 'water', 'desert'), { material: 'Water-resistant pouch', activity: 'Safety', weight_g: 300 }, null, { features: ['Stocked for 1–4 people, 1–7 days', 'Labelled compartments', 'Field guide included'] }],
  ['Emergency Bivvy', 'accessories/travel-tech', 45, tags('trek', 'alpine', 'desert'), { material: 'Reflective polyethylene', activity: 'Safety', weight_g: 110 }, null, { features: ['Reflects 90% of body heat', 'Bright orange exterior', 'Reusable'] }],
  ['Trail Gaiters', 'accessories/travel-tech', 59, tags('trek', 'desert', 'alpine'), { material: 'Stretch softshell', activity: 'Trekking' }, null, { features: ['Keeps scree and sand out', 'Instep strap', 'Low-profile fit'] }],
  ['Insect Head Net', 'accessories/travel-tech', 15, tags('trek', 'water', 'travel'), { material: 'Fine no-see-um mesh', activity: 'Trekking' }, null, { features: ['Stops midges and mosquitoes', 'Fits over hats', 'Packs tiny'] }],
  ['Travel Sewing & Repair Kit', 'accessories/travel-tech', 25, tags('trek', 'travel', 'climb'), { material: 'Assorted', activity: 'Trekking' }, null, { features: ['Tenacious tape, needle, thread and buttons', 'Seam-grip adhesive', 'Zip pull replacements'] }],
  ['Silk Sleeping Bag Liner', 'accessories/travel-tech', 89, tags('travel', 'trek'), { material: '100% silk', activity: 'Travel', weight_g: 130 }, null, { features: ['Adds warmth and keeps bags clean', 'Ideal for huts and hostels', 'Packs to the size of an orange'] }],
  ['Noise-Cancelling Earbuds', 'accessories/travel-tech', 199, tags('travel'), { material: 'IPX4 earbuds', activity: 'Travel' }, null, { features: ['Active noise cancelling for long-haul', '30-hour battery with case', 'Multipoint pairing'] }],
  ['Packable Hammock', 'accessories/travel-tech', 79, tags('travel', 'water', 'trek'), { material: 'Parachute nylon', activity: 'Camp', weight_g: 380 }, 'packColor', { features: ['Holds up to 180 kg', 'Tree-friendly straps included', 'Packs into attached pouch'] }],
  ['Biodegradable Wash Kit', 'accessories/travel-tech', 29, tags('trek', 'water', 'travel'), { material: 'Plant-based soaps', activity: 'Camp' }, null, { features: ['Leave-no-trace soap for body, dishes and laundry', 'Collapsible basin', 'Travel-size'] }],
  ['Rugged Phone Tripod', 'accessories/travel-tech', 59, tags('photo', 'travel'), { material: 'Aluminium with flexible legs', activity: 'Photography' }, null, { features: ['Wraps around branches and rails', 'Bluetooth shutter remote', 'Fits all phones'] }],
  ['Camera Rain Cover', 'accessories/travel-tech', 45, tags('photo'), { material: 'Waterproof nylon', activity: 'Photography' }, null, { features: ['Fits DSLR and mirrorless with lenses up to 300 mm', 'Clear viewing window', 'Drawcord lens fit'] }],
  ['Kids Adventure Kit', 'accessories/travel-tech', 69, tags('travel', 'trek'), { material: 'Assorted', activity: 'Family' }, null, { features: ['Compass, whistle, torch and field journal', 'Durable carry pouch', 'Ages 6+'] }],
  ['Luggage Tracker Tag', 'accessories/travel-tech', 39, tags('travel'), { material: 'Bluetooth tracker', activity: 'Travel' }, null, { features: ['Find bags anywhere in the airport', 'Replaceable battery', 'Works with your phone\'s finder app'] }],
  ['Trekking Umbrella', 'accessories/travel-tech', 69, tags('trek', 'travel', 'photo'), { material: 'Carbon shaft, UV-reflective canopy', activity: 'Trekking', weight_g: 210 }, null, { features: ['Hands-free attachment for pack shoulder straps', 'UPF 50+ silver canopy', 'Windproof flex ribs'] }],
  ['Lightweight Camp Chair', 'accessories/travel-tech', 119, tags('trek', 'photo', 'water'), { material: 'Aluminium frame, ripstop seat', activity: 'Camp', weight_g: 900 }, 'packColor', { features: ['Sets up in seconds', 'Holds 145 kg', 'Packs smaller than a water bottle'] }],
  // ---------- Additional apparel ----------
  ['Kids Torrent Rain Jacket', 'apparel/jackets', 129, tags('trek', 'travel'), { material: '2.5-layer recycled polyester', activity: 'Family', gender: 'Kids', weight_g: 220, waterproof_rating: '10,000 mm' }, 'water', { features: ['Grow-cuff extends sleeves one size', 'Reflective trims', 'Name label inside'] }],
  ['Trail Leggings', 'apparel/pants', 99, tags('trek', 'climb', 'cycle'), { material: 'Recycled nylon-elastane', activity: 'Hiking', gender: 'Women', weight_g: 190 }, 'pants', { features: ['Squat-proof, abrasion-resistant knit', 'Side drop-in phone pockets', 'High-rise waistband'] }],
  ['Merino Hut Slippers', 'apparel/socks', 49, tags('travel', 'alpine', 'trek'), { material: 'Merino upper, grippy sole', activity: 'Basecamp', gender: 'Unisex', weight_g: 120 }, 'sock', { features: ['Cosy refuge and hut footwear', 'Packs flat', 'Non-slip sole'] }],
];
/* eslint-enable max-len */
