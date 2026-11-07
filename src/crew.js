import { pick, mulberry32 } from './util.js';

/**
 * Crew as character cards. Each person has a role (what they did before the flood), two or three
 * traits that change how the boat handles or how the crew get by, a short history that grows as
 * things happen to them, and a portrait.
 *
 * Portraits: every person draws one id from PORTRAITS (stable per person). The game loads
 * `portraits/<id>.webp` and falls back to a generated placeholder until that file exists. The
 * descriptions below are the briefs for the artwork (see docs/portraits.md).
 */

export const TRAITS = {
  oldsalt: { name: 'Old Salt', desc: 'Sails point 4° closer to the wind and draw 12% harder.' },
  mechanic: { name: 'Mechanic', desc: '+20% engine power and a quarter less fuel burned.' },
  strong: { name: 'Strong Back', desc: 'Rowing is 35% stronger.' },
  eyes: { name: 'Sharp Eyes', desc: 'Spots survivors, boats and supplies 40% further off, and calls out shoals and low bridges early.' },
  pilot: { name: 'Pilot', desc: 'Knows these waters: calls the depth under the keel and the clearance under bridges.' },
  carpenter: { name: 'Carpenter', desc: 'Repairs go 50% faster and patching costs a third less.' },
  nurse: { name: 'Nurse', desc: 'The injured and the hungry recover twice as fast.' },
  cook: { name: 'Cook', desc: 'The crew eat a quarter less.' },
  steady: { name: 'Steady', desc: 'Morale falls more slowly while they are aboard.' },
  skittish: { name: 'Skittish', desc: 'Morale drops sharply when the hull is hit.', bad: true },
  // earned on the voyage
  stormtested: { name: 'Storm-tested', desc: 'Came through a gale under sail. Gale damage to the rig is halved.', earned: true },
  bridgehand: { name: 'Low-Bridge Hand', desc: 'Has taken the mast down under a bridge before. Striking and raising the mast takes half as long.', earned: true },
  rescuer: { name: 'Rescuer', desc: 'Has pulled people out of the water. Rescued survivors arrive in better spirits (+morale).', earned: true },
};

export const ROLES = {
  fisher: { name: 'Fisher', traits: ['oldsalt', 'eyes', 'strong', 'cook'] },
  ferryman: { name: 'Ferry hand', traits: ['pilot', 'oldsalt', 'steady'] },
  mechanic: { name: 'Mechanic', traits: ['mechanic', 'carpenter', 'strong'] },
  nurse: { name: 'Nurse', traits: ['nurse', 'steady', 'cook'] },
  carpenter: { name: 'Carpenter', traits: ['carpenter', 'strong', 'steady'] },
  harbour: { name: 'Harbour pilot', traits: ['pilot', 'eyes', 'oldsalt'] },
  cook: { name: 'Café owner', traits: ['cook', 'steady', 'nurse'] },
  teacher: { name: 'Teacher', traits: ['steady', 'eyes', 'nurse'] },
  kid: { name: 'Kid', traits: ['eyes', 'skittish', 'strong'] },
  student: { name: 'Student', traits: ['eyes', 'mechanic', 'skittish'] },
  postie: { name: 'Postal worker', traits: ['pilot', 'strong', 'steady'] },
  retired: { name: 'Retired yachtsman', traits: ['oldsalt', 'pilot', 'skittish'] },
};

const BIOS = {
  fisher: ['Worked the inshore boats out of the harbour for thirty years.', 'Lost the family trawler on the first night and has not said much since.', 'Knows every mooring and every rumour on the waterfront.'],
  ferryman: ['Ran the river ferry until the landing went under.', 'Can bring a boat alongside anything, in anything.'],
  mechanic: ['Kept the delivery vans running behind the market. Boats are just vans that float.', 'Has a bag of tools and will not let go of it.'],
  nurse: ['Was on shift at the clinic when the water came in through the doors.', 'Came off a night shift into a flood and has not slept since.'],
  carpenter: ['Built half the decks in the old town and is not pleased to see them floating.', 'Carries a pencil behind one ear even now.'],
  harbour: ['Brought ships in through the channel for twenty years.', 'Reads water the way other people read faces.'],
  cook: ['Ran the café on the quay. Fed the last of the regulars before the roof went.', 'Cannot sit still if anyone nearby is hungry.'],
  teacher: ['Got a class out of the school on the first morning. Has been looking for the rest since.', 'Keeps a list of everyone they meet.'],
  kid: ['Separated from their family at the bridge. Insists they are fine.', 'Has a whistle and a lot of opinions about boats.'],
  student: ['Was home for the holidays. Has a dead phone and a working brain.', 'Studies engineering; this was not on the syllabus.'],
  postie: ['Knows every street in town, including the ones under water now.', 'Kept doing the round for two days after the water rose.'],
  retired: ['Sailed round the world once, and will tell you about it.', 'Sold the yacht last spring and regrets it this week.'],
};

/** Portrait briefs. 36 people so a voyage rarely repeats a face. */
export const PORTRAITS = [
  ['p01', 'woman, about 60, weathered face, grey hair in a long braid, yellow oilskin jacket'],
  ['p02', 'man, about 45, broad, stubble, knitted watch cap, navy fisherman\'s jumper'],
  ['p03', 'teenage girl, about 14, wet curly hair, oversized hoodie, whistle on a cord'],
  ['p04', 'man, about 70, white beard, sailing cap, faded blue windbreaker'],
  ['p05', 'woman, about 35, nurse\'s scrubs under a rain jacket, hair tied back, tired eyes'],
  ['p06', 'man, about 30, mechanic\'s overalls, grease on his hands and cheek, headlamp around neck'],
  ['p07', 'woman, about 50, short silver hair, reading glasses pushed up, cardigan, clipboard'],
  ['p08', 'boy, about 10, life jacket too big for him, muddy face, holding a torch'],
  ['p09', 'woman, about 25, shaved head, denim jacket covered in patches, nose ring'],
  ['p10', 'man, about 55, bald, round glasses, apron over a shirt, flour on his sleeves'],
  ['p11', 'woman, about 40, high-vis vest, postal worker\'s satchel, freckles'],
  ['p12', 'man, about 20, student, thin, messy hair, hoodie, scratched spectacles'],
  ['p13', 'woman, about 65, headscarf, warm wool coat, strong hands, calm expression'],
  ['p14', 'man, about 40, carpenter, sawdust in his beard, pencil behind his ear, flannel shirt'],
  ['p15', 'woman, about 30, ferry company uniform jacket, rope burns on her palms'],
  ['p16', 'man, about 60, harbour pilot, peaked cap, binoculars, deep-set eyes'],
  ['p17', 'girl, about 12, braids, school blazer soaked through, determined look'],
  ['p18', 'man, about 35, wetsuit top under a raincoat, sunburnt nose'],
  ['p19', 'woman, about 55, café owner, curly red hair going grey, sleeves rolled up'],
  ['p20', 'man, about 25, tattoos on his forearms, fishing waders, cigarette behind ear'],
  ['p21', 'woman, about 45, engineer, safety glasses on her head, utility belt'],
  ['p22', 'man, about 75, tweed jacket, walking stick, mischievous smile'],
  ['p23', 'woman, about 20, raincoat over a party dress, mascara run, laughing anyway'],
  ['p24', 'man, about 50, priest\'s collar under an anorak, kind face, wet hair'],
  ['p25', 'woman, about 38, firefighter\'s jacket, soot on her face, short dark hair'],
  ['p26', 'boy, about 15, skateboard under his arm, headphones round his neck'],
  ['p27', 'man, about 45, suit ruined by water, loosened tie, holding his shoes'],
  ['p28', 'woman, about 70, tiny, enormous glasses, hand-knitted hat, holding a cat basket'],
  ['p29', 'man, about 30, delivery rider jacket, helmet hair, quick grin'],
  ['p30', 'woman, about 28, climbing harness, ropes over her shoulder, ponytail'],
  ['p31', 'man, about 65, ex-navy, upright posture, short white hair, duffel coat'],
  ['p32', 'woman, about 42, shopkeeper, gold earrings, patterned scarf, practical boots'],
  ['p33', 'man, about 22, lifeguard hoodie, whistle, sun-bleached hair'],
  ['p34', 'woman, about 58, teacher, grey bob, lanyard with keys, rain-spotted glasses'],
  ['p35', 'man, about 38, farmer, flat cap, wax jacket, muddy hands'],
  ['p36', 'woman, about 33, scientist, field notebook, waterproof jacket, hair under a beanie'],
];
export const CAPTAIN_PORTRAIT = 'captain';

/** A new card for a person, deterministic from their seed. */
export function makeCard(seed, opts = {}) {
  const r = mulberry32(seed ^ 0x5bd1e995);
  if (opts.captain) return { role: 'captain', roleName: 'Skipper', traits: ['steady'], bio: 'Your boat, your call.', portrait: CAPTAIN_PORTRAIT, history: [] };
  const role = pick(r, Object.keys(ROLES));
  const pool = ROLES[role].traits.slice();
  const traits = [];
  const n = r() < 0.3 ? 1 : 2;
  while (traits.length < n && pool.length) {
    // the first-listed trait of a role is the likeliest
    const i = r() < 0.55 ? 0 : Math.floor(r() * pool.length);
    traits.push(pool.splice(i, 1)[0]);
  }
  return { role, roleName: ROLES[role].name, traits, bio: pick(r, BIOS[role]), portrait: pick(r, PORTRAITS)[0], history: [] };
}

/** Give a person a trait earned from what happened to them. Returns true if it was new. */
export function earnTrait(person, id, reason) {
  const c = person.card;
  if (!c || c.traits.includes(id)) return false;
  c.traits.push(id);
  c.history.push(reason);
  return true;
}
export function addHistory(person, line) {
  if (!person.card) return;
  person.card.history.push(line);
  if (person.card.history.length > 12) person.card.history.shift();
}

// ---------------------------------------------------------------------------
// Placeholder portraits: a silhouette on a colour from the portrait id, with the person's initial.
// ---------------------------------------------------------------------------
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
export function placeholderPortrait(id, name) {
  const h = hash(id), hue = h % 360, hue2 = (hue + 40) % 360;
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},32%,38%)"/><stop offset="1" stop-color="hsl(${hue2},28%,18%)"/></linearGradient></defs>
<rect width="160" height="200" fill="url(#g)"/>
<circle cx="80" cy="78" r="34" fill="rgba(0,0,0,0.35)"/>
<path d="M20 200 C24 140 52 122 80 122 C108 122 136 140 140 200 Z" fill="rgba(0,0,0,0.35)"/>
<text x="80" y="92" font-family="Georgia,serif" font-size="40" fill="rgba(255,255,255,0.75)" text-anchor="middle">${initial}</text>
<text x="152" y="192" font-family="sans-serif" font-size="10" fill="rgba(255,255,255,0.35)" text-anchor="end">${id}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
/** <img> markup that shows the real portrait once it exists and the placeholder until then. */
const missing = (globalThis.__floatillaMissingPortraits = new Set()); // ids with no artwork yet: skip the request next time
export function portraitImg(person, cls = 'portrait') {
  const id = person.card ? person.card.portrait : 'p00';
  const ph = placeholderPortrait(id, person.name);
  if (missing.has(id)) return `<img class="${cls}" src="${ph}" alt="${person.name}">`;
  return `<img class="${cls}" src="portraits/${id}.webp" onerror="this.onerror=null;__floatillaMissingPortraits.add('${id}');this.src='${ph}'" alt="${person.name}">`;
}

/** Count of a trait among a boat's crew. */
export function crewTrait(boat, id) {
  let n = 0;
  for (const p of boat.crew) if (p.card && p.card.traits.includes(id)) n++;
  return n;
}
