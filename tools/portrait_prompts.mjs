// Prints one image-generation prompt per portrait id, from the briefs in src/crew.js.
// Usage: node tools/portrait_prompts.mjs > portraits.txt
import { PORTRAITS, CAPTAIN_PORTRAIT } from '../src/crew.js';

const STYLE = 'Painted character portrait for a card game, head and shoulders, three-quarter view, ' +
  'muted coastal palette (slate blue, sea green, oilskin yellow, rust), soft overcast light, visible brush texture, ' +
  'plain dark blue-grey background with faint rain streaks, no text, no frame, no logo. Portrait orientation 4:5.';

const rows = [[CAPTAIN_PORTRAIT, 'adult of indeterminate age and gender, the player character, orange life vest over a navy jacket, yellow sou\'wester hat, face partly in shadow so the player can project onto it'], ...PORTRAITS];
for (const [id, look] of rows) console.log(`${id}.webp\t${look}. ${STYLE}`);
