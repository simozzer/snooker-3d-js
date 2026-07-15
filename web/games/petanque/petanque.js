// petanque.js — pétanque / boules. The GAME (physics, turns, AI) is pure client-side and lives here in 2D
// "plan" coordinates (x:0..W, y:0..H): you THROW with an arc (an aerial phase that lands and then rolls),
// and the surface is ROUGH GRAVEL — high friction plus a little random deflection on landing and while
// rolling, so the terrain never plays quite fair. The RENDERING is real hand-rolled WebGL 3D over in
// petanque-gl.js (a low camera over the piste, lit steel boules, and a loitering Lowry crowd); this file
// just feeds it the plan-coordinate state and turns pointer rays back into plan coordinates for aiming.
// Closest boule to the jack wins the end; first to 13. Play vs a simple computer or pass-and-play.

import { VERSION } from '../../version.js';
import { createPetanqueRenderer } from './petanque-gl.js';

const cv = document.getElementById('piste');
const overlay = document.getElementById('aim');
const el = (id) => document.getElementById(id);
const W = 900, H = 560;   // logical "plan" play-field (independent of the WebGL canvas pixel size)

// --- geometry + tuning ------------------------------------------------------------------------------
const R = 13, JACK_R = 7;                 // boule / jack radii
const THROW = { x: W / 2, y: H - 52 };    // the throwing circle (bottom centre)
const P = { x0: 30, y0: 28, x1: W - 30, y1: H - 20 };   // playable piste rectangle
const FRICTION = 680;                     // px/s^2 rolling deceleration — high, for gravel (short roll)
const ROLL_MAX = 560;                     // residual speed for a full "roll" throw
const REST = 9;                           // speed below which a body is at rest
const ROUGH = 0.9;                        // gravel character 0..1 (landing kick + rolling wobble)
const FLIGHT_MIN = 380, FLIGHT_PER_PX = 0.9; // aerial time in ms

// Throw control: you DRAG out from the throwing circle. The drag DIRECTION is your line, and the drag
// LENGTH is the power (mapped to an aerial landing distance) — NOT the cursor position, so aiming the
// cursor straight at the jack and pulling hard sails long past it. You judge force and line, never click
// an exact spot. And no two throws of the same drag land alike (AIM_SPREAD), because a hand isn't a ruler.
const DRAG_MIN = 16, DRAG_MAX = 205;                  // px of drag → 0..full power
const DIST_MIN = 80, DIST_MAX = 486;                  // aerial landing distance (px) mapped from power
const AIM_SPREAD_ANG = 0.045, AIM_SPREAD_DIST = 0.05; // ± line / ± distance a throw can stray by itself

// Shot shaping: LOFT (0=high lob, 1=flat roll) sets the arc height + how far the boule runs after it lands;
// SPIN (-1..+1) bows the flight path sideways (a banana curve) and makes the boule grab/hook on landing.
const LIFT_BASE = 96;                 // world-unit apex height reference (scaled up for lobs, flattened for rolls)
const CURVE_MAX = 130;                // px of sideways bow in the flight path at full spin
const arcHeight = (loft) => LIFT_BASE * (1.25 - loft);   // lob → tall arc, roll → skimming

// Sample the flight path (plan coords + aerial height) so the aim overlay and the physics agree on the shape.
function flightArc(from, to, loft, spin, n = 26) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len, curve = spin * CURVE_MAX, H = arcHeight(loft);
  const pts = [];
  for (let i = 0; i <= n; i++) { const k = i / n, s = Math.sin(k * Math.PI);
    pts.push({ x: from.x + dx * k + px * curve * s, y: from.y + dy * k + py * curve * s, lift: s * H }); }
  return pts;
}

// Up to four players. Each boule has BOTH a colour and a distinct FINISH — one band, two bands, smooth,
// or dotted (lawn-bowls style) — so players are told apart by look alone, not colour. The HUD shows a
// matching mini-ball swatch (patSwatch below).
const TEAM = [
  { name: 'Blue',  pattern: 'band1',  fill: ['#dcecff', '#5a86dd', '#31509a'] },
  { name: 'Red',   pattern: 'band2',  fill: ['#ffd9cb', '#d86a4f', '#9a3b2a'] },
  { name: 'Green', pattern: 'smooth', fill: ['#cdead0', '#57ab5e', '#2f6a35'] },
  { name: 'Amber', pattern: 'dots',   fill: ['#ffe9c2', '#e0a93a', '#946a16'] },
];
// A tiny inline-SVG boule that mirrors a player's colour + finish, for the HUD chips.
function patSwatch(i) {
  const t = TEAM[i], col = t.fill[1], dk = '#12202c';
  let marks = '';
  if (t.pattern === 'band1') marks = `<rect x="0" y="6.4" width="16" height="3.2" fill="${dk}"/>`;
  else if (t.pattern === 'band2') marks = `<rect x="0" y="3.6" width="16" height="2.4" fill="${dk}"/><rect x="0" y="10" width="16" height="2.4" fill="${dk}"/>`;
  else if (t.pattern === 'dots') marks = [[5, 5], [11, 5], [8, 8], [5, 11], [11, 11]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${dk}"/>`).join('');
  return `<svg width="16" height="16" viewBox="0 0 16 16" class="pat" aria-hidden="true">`
    + `<defs><clipPath id="cb${i}"><circle cx="8" cy="8" r="7.2"/></clipPath></defs>`
    + `<circle cx="8" cy="8" r="7.2" fill="${col}"/><g clip-path="url(#cb${i})">${marks}</g>`
    + `<circle cx="8" cy="8" r="7.2" fill="none" stroke="rgba(0,0,0,.4)"/></svg>`;
}

const renderer = createPetanqueRenderer(cv, overlay, { W, H, P, THROW, R, JACK_R, TEAM });

// --- procedural sound (WebAudio, zero assets) -----------------------------------------------------
// A soft gravel thud on landing, a metallic clink on a collision (pitched by how hard the click was),
// and a little chime when you take an end. The context is created/resumed on your first gesture.
const sfx = (() => {
  let ctx = null, muted = false, lastClink = 0;
  const ensure = () => {
    try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ }
    return ctx;
  };
  function thud() {
    const c = ensure(); if (!c || muted) return;
    const t = c.currentTime, len = Math.floor(0.16 * c.sampleRate);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2); // gravel crunch
    const src = c.createBufferSource(); src.buffer = buf;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 430;
    const g = c.createGain(); g.gain.value = 0.16;
    src.connect(lp).connect(g).connect(c.destination); src.start(t);
  }
  function clink(s) {
    const c = ensure(); if (!c || muted) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (now - lastClink < 45) return; lastClink = now; // don't machine-gun on a cluster
    const t = c.currentTime, freq = 880 + s * 1500, vol = 0.04 + s * 0.16;
    for (const mul of [1, 1.48]) {
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = freq * mul;
      const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.18);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.2);
    }
  }
  function chime() {
    const c = ensure(); if (!c || muted) return;
    const t0 = c.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = c.createGain(), t = t0 + i * 0.1;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.4);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.42);
    });
  }
  return { thud, clink, chime, resume: ensure, toggle() { muted = !muted; return muted; }, get muted() { return muted; } };
})();

// --- the French referee (pure comedy) -------------------------------------------------------------
// Announces every landing with a French word or phrase — from proper boules calls, through random nouns
// (banana, bicycle, cheese…), to full nonsense ("where is my bicycle?", "why do you smell?"), and now and
// then the obligatory "hon hon hon". A caption always shows; it's SPOKEN aloud (fr-FR) unless sound's muted.
const referee = (() => {
  // Each line is bilingual: fr = spoken/captioned French, en = the subtitle translation (education!).
  const PHRASES = [
    { fr: 'Boule !', en: 'Ball!' }, { fr: 'Pétanque !', en: 'Pétanque!' }, { fr: 'Le cochonnet !', en: 'The jack!' },
    { fr: 'Tirez !', en: 'Shoot!' }, { fr: 'Pointez !', en: 'Point!' }, { fr: 'Carreau !', en: 'Direct hit!' },
    { fr: 'Le bouchon !', en: 'The jack!' }, { fr: 'Fanny !', en: 'Whitewash!' }, { fr: 'Un point !', en: 'One point!' },
    { fr: 'Le but !', en: 'The target!' },
    { fr: 'La banane.', en: 'The banana.' }, { fr: 'La bicyclette.', en: 'The bicycle.' }, { fr: 'Le fromage.', en: 'The cheese.' },
    { fr: 'Le croissant.', en: 'The croissant.' }, { fr: 'La baguette.', en: 'The baguette.' }, { fr: "L'escargot.", en: 'The snail.' },
    { fr: 'Le béret.', en: 'The beret.' }, { fr: 'La moustache.', en: 'The moustache.' }, { fr: 'Le pamplemousse.', en: 'The grapefruit.' },
    { fr: 'La grenouille.', en: 'The frog.' }, { fr: 'Le camembert.', en: 'The camembert.' }, { fr: 'La saucisse.', en: 'The sausage.' },
    { fr: 'Le parapluie.', en: 'The umbrella.' }, { fr: 'La chaussette.', en: 'The sock.' }, { fr: 'Le canard.', en: 'The duck.' },
    { fr: 'Zut alors !', en: 'Darn it!' }, { fr: 'Sacré bleu !', en: 'Good heavens!' }, { fr: 'Oh là là !', en: 'Oh my!' },
    { fr: 'Magnifique !', en: 'Magnificent!' }, { fr: 'Catastrophe !', en: 'Disaster!' }, { fr: 'Formidable !', en: 'Terrific!' },
    { fr: 'Incroyable !', en: 'Incredible!' }, { fr: 'Quelle horreur !', en: 'How awful!' }, { fr: "C'est la vie.", en: "That's life." },
    { fr: 'Bof.', en: 'Meh.' }, { fr: 'Mon Dieu !', en: 'My God!' },
    { fr: 'Où est ma bicyclette ?', en: 'Where is my bicycle?' }, { fr: 'Pourquoi tu sens mauvais ?', en: 'Why do you smell bad?' },
    { fr: 'Je suis une pomme de terre.', en: 'I am a potato.' }, { fr: 'Le chat porte un chapeau.', en: 'The cat is wearing a hat.' },
    { fr: 'As-tu vu mon fromage ?', en: 'Have you seen my cheese?' }, { fr: 'Il pleut des grenouilles.', en: "It's raining frogs." },
    { fr: 'Ma grand-mère fait du vélo.', en: 'My grandmother rides a bike.' }, { fr: 'Le poisson est fatigué.', en: 'The fish is tired.' },
    { fr: 'Où sont mes chaussettes ?', en: 'Where are my socks?' }, { fr: 'Tu danses comme un canard.', en: 'You dance like a duck.' },
    { fr: 'Mon pantalon est trop petit.', en: 'My trousers are too small.' }, { fr: 'Le président mange une baguette.', en: 'The president is eating a baguette.' },
    { fr: "Je n'aime pas le lundi.", en: "I don't like Monday." }, { fr: 'Ton chapeau est ridicule.', en: 'Your hat is ridiculous.' },
    { fr: 'Le café.', en: 'The coffee.' }, { fr: 'Le vin rouge.', en: 'The red wine.' }, { fr: 'La moutarde.', en: 'The mustard.' },
    { fr: 'Le beurre.', en: 'The butter.' }, { fr: 'La crème.', en: 'The cream.' }, { fr: 'Le pain.', en: 'The bread.' },
    { fr: 'La tarte.', en: 'The tart.' }, { fr: 'Le gâteau.', en: 'The cake.' }, { fr: 'La confiture.', en: 'The jam.' },
    { fr: 'Le chocolat.', en: 'The chocolate.' }, { fr: 'La brioche.', en: 'The brioche.' }, { fr: 'Le poireau.', en: 'The leek.' },
    { fr: "L'aubergine.", en: 'The aubergine.' }, { fr: 'La courgette.', en: 'The courgette.' }, { fr: 'Le champignon.', en: 'The mushroom.' },
    { fr: 'La cerise.', en: 'The cherry.' }, { fr: 'La fraise.', en: 'The strawberry.' }, { fr: 'Le raisin.', en: 'The grape.' },
    { fr: "L'oignon.", en: 'The onion.' }, { fr: "L'ail.", en: 'The garlic.' }, { fr: 'Le homard.', en: 'The lobster.' },
    { fr: "L'huître.", en: 'The oyster.' }, { fr: 'La truffe.', en: 'The truffle.' }, { fr: 'Le cornichon.', en: 'The gherkin.' },
    { fr: 'La ratatouille.', en: 'The ratatouille.' },
    { fr: 'Le hérisson.', en: 'The hedgehog.' }, { fr: 'Le hibou.', en: 'The owl.' }, { fr: 'La chèvre.', en: 'The goat.' },
    { fr: 'Le mouton.', en: 'The sheep.' }, { fr: 'Le cheval.', en: 'The horse.' }, { fr: 'La vache.', en: 'The cow.' },
    { fr: 'Le cochon.', en: 'The pig.' }, { fr: 'La poule.', en: 'The hen.' }, { fr: 'Le coq.', en: 'The rooster.' },
    { fr: 'Le lapin.', en: 'The rabbit.' }, { fr: 'La souris.', en: 'The mouse.' }, { fr: "L'âne.", en: 'The donkey.' },
    { fr: 'Le papillon.', en: 'The butterfly.' }, { fr: "L'abeille.", en: 'The bee.' }, { fr: 'Le crapaud.', en: 'The toad.' },
    { fr: 'La libellule.', en: 'The dragonfly.' },
    { fr: 'Le tabouret.', en: 'The stool.' }, { fr: 'La brouette.', en: 'The wheelbarrow.' }, { fr: 'Le tire-bouchon.', en: 'The corkscrew.' },
    { fr: "L'accordéon.", en: 'The accordion.' }, { fr: 'La guillotine.', en: 'The guillotine.' }, { fr: 'Le tricycle.', en: 'The tricycle.' },
    { fr: 'La casquette.', en: 'The cap.' }, { fr: 'Les lunettes.', en: 'The glasses.' }, { fr: 'Le mouchoir.', en: 'The handkerchief.' },
    { fr: 'La valise.', en: 'The suitcase.' }, { fr: 'Le tournevis.', en: 'The screwdriver.' }, { fr: 'La cuillère.', en: 'The spoon.' },
    { fr: 'Le balai.', en: 'The broom.' }, { fr: "L'oreiller.", en: 'The pillow.' },
    { fr: 'Voilà !', en: 'There it is!' }, { fr: 'Enfin !', en: 'At last!' }, { fr: 'Hélas !', en: 'Alas!' },
    { fr: 'Aïe !', en: 'Ouch!' }, { fr: 'Oups !', en: 'Oops!' }, { fr: 'Bravo !', en: 'Well done!' },
    { fr: 'Superbe !', en: 'Superb!' }, { fr: 'Épouvantable !', en: 'Dreadful!' }, { fr: 'Splendide !', en: 'Splendid!' },
    { fr: "Nom d'un chien !", en: 'Good grief!' }, { fr: 'Ça alors !', en: 'Well I never!' }, { fr: 'Pas mal.', en: 'Not bad.' },
    { fr: 'Comme ci comme ça.', en: 'So-so.' }, { fr: "N'importe quoi !", en: 'Nonsense!' }, { fr: 'Doucement…', en: 'Gently…' },
    { fr: 'Attention !', en: 'Careful!' }, { fr: 'Tant pis.', en: 'Too bad.' }, { fr: 'Tant mieux.', en: 'All the better.' },
    { fr: 'Et voilà le travail !', en: 'And there we go!' }, { fr: 'Chapeau !', en: 'Hats off!' },
    { fr: 'Mon oncle est un fromage.', en: 'My uncle is a cheese.' }, { fr: 'Le canard a volé ma montre.', en: 'The duck stole my watch.' },
    { fr: "J'ai perdu mon éléphant.", en: 'I lost my elephant.' }, { fr: 'As-tu mangé ma chaussure ?', en: 'Did you eat my shoe?' },
    { fr: 'Le fromage me regarde.', en: 'The cheese is watching me.' }, { fr: 'Pourquoi la lune est carrée ?', en: 'Why is the moon square?' },
    { fr: 'Ma tortue joue du piano.', en: 'My tortoise plays the piano.' }, { fr: 'Le facteur danse le tango.', en: 'The postman is dancing the tango.' },
    { fr: 'Je collectionne les nuages.', en: 'I collect clouds.' }, { fr: "Ton cheval a besoin d'un dentiste.", en: 'Your horse needs a dentist.' },
    { fr: 'Où est passé mon accordéon ?', en: 'Where has my accordion gone?' }, { fr: 'La soupe est trop bavarde.', en: 'The soup is too chatty.' },
    { fr: 'Mon voisin parle aux escargots.', en: 'My neighbour talks to snails.' }, { fr: 'Le président a perdu son béret.', en: 'The president has lost his beret.' },
    { fr: 'Il y a une grenouille dans ma poche.', en: "There's a frog in my pocket." }, { fr: 'Ta moustache est magnifique.', en: 'Your moustache is magnificent.' },
    { fr: 'Le train pour Paris est en retard.', en: 'The train to Paris is late.' }, { fr: "J'ai épousé une baguette.", en: 'I married a baguette.' },
    { fr: 'Le chat a mangé le maire.', en: 'The cat ate the mayor.' }, { fr: 'Range ta chambre !', en: 'Tidy your room!' },
    { fr: 'Ne mange pas le cochonnet !', en: "Don't eat the jack!" }, { fr: 'Tu joues comme mon grand-père.', en: 'You play like my grandfather.' },
    { fr: 'Encore une catastrophe !', en: 'Another disaster!' }, { fr: 'La vache regarde le train.', en: 'The cow is watching the train.' },
    { fr: 'Mon chapeau a des opinions.', en: 'My hat has opinions.' },
    { fr: "J'ai inventé le fromage.", en: 'I invented cheese.' }, { fr: 'Je suis le roi de la pétanque.', en: 'I am the king of pétanque.' },
    { fr: 'Mon chien parle trois langues.', en: 'My dog speaks three languages.' }, { fr: "J'ai mangé la lune hier soir.", en: 'I ate the moon last night.' },
    { fr: 'Je peux voler quand personne ne regarde.', en: 'I can fly when nobody is looking.' }, { fr: "J'ai battu Napoléon aux boules.", en: 'I beat Napoleon at boules.' },
    { fr: "Ma moustache prédit l'avenir.", en: 'My moustache predicts the future.' }, { fr: "J'ai deux cents ans.", en: 'I am two hundred years old.' },
    { fr: 'Je suis champion du monde de sieste.', en: 'I am the world nap champion.' }, { fr: "J'ai un doctorat en fromage.", en: 'I have a PhD in cheese.' },
    { fr: 'Je parle couramment le canard.', en: 'I speak fluent duck.' }, { fr: "J'ai gagné le Tour de France à pied.", en: 'I won the Tour de France on foot.' },
    { fr: 'Mes boules sont magiques.', en: 'My boules are magic.' }, { fr: "Je n'ai jamais perdu une partie.", en: 'I have never lost a game.' },
    { fr: "J'ai dressé une armée d'escargots.", en: 'I trained an army of snails.' }, { fr: 'Le soleil se lève pour me saluer.', en: 'The sun rises to greet me.' },
    { fr: "Je suis plus fort qu'un tracteur.", en: 'I am stronger than a tractor.' }, { fr: 'Mon béret est béni par le pape.', en: 'My beret is blessed by the Pope.' },
    { fr: "J'ai inventé la marche arrière.", en: 'I invented reversing.' }, { fr: 'Je peux soulever un cheval.', en: 'I can lift a horse.' },
    { fr: "J'ai trois estomacs.", en: 'I have three stomachs.' }, { fr: "J'ai vu le futur, c'est bleu.", en: "I've seen the future, it's blue." },
    { fr: 'Je cuisine mieux que ta mère.', en: 'I cook better than your mother.' }, { fr: 'Ma boule a un diplôme.', en: 'My boule has a diploma.' },
    { fr: "J'ai domestiqué le tonnerre.", en: 'I tamed thunder.' }, { fr: 'Personne ne lance comme moi.', en: 'Nobody throws like me.' },
    { fr: "J'ai gagné à la loterie douze fois.", en: 'I won the lottery twelve times.' }, { fr: "Je suis l'inventeur du dimanche.", en: 'I am the inventor of Sunday.' },
    { fr: "Mon chat me doit de l'argent.", en: 'My cat owes me money.' }, { fr: "J'ai mangé un dictionnaire, je sais tout.", en: 'I ate a dictionary, I know everything.' },
    { fr: "J'ai un jumeau sur la lune.", en: 'I have a twin on the moon.' }, { fr: 'Ma grand-mère soulève des voitures.', en: 'My grandmother lifts cars.' },
    { fr: "J'ai inventé le silence.", en: 'I invented silence.' }, { fr: 'Les pigeons travaillent pour moi.', en: 'The pigeons work for me.' },
    { fr: "J'ai écrit la Marseillaise.", en: 'I wrote the Marseillaise.' }, { fr: 'Je suis invisible le mardi.', en: 'I am invisible on Tuesdays.' },
    { fr: 'Mon parapluie contrôle la météo.', en: 'My umbrella controls the weather.' }, { fr: "J'ai battu un ours au bras de fer.", en: 'I beat a bear at arm wrestling.' },
    { fr: 'Je suis le meilleur, demandez à ma mère.', en: 'I am the best, ask my mother.' }, { fr: "J'ai inventé l'eau.", en: 'I invented water.' },
    { fr: 'Ma boule obéit à mes pensées.', en: 'My boule obeys my thoughts.' }, { fr: "J'ai vécu mille vies.", en: 'I have lived a thousand lives.' },
    { fr: 'Je fais pleuvoir en claquant des doigts.', en: 'I make it rain by snapping my fingers.' },
    { fr: "J'ai appris à lire aux poissons.", en: 'I taught fish to read.' }, { fr: 'Le vent me demande la permission.', en: 'The wind asks my permission.' },
    { fr: "Un phoque m'a poussé sous la douche.", en: 'A seal pushed me in the shower.' }, { fr: "J'ai appris à nager à un chameau.", en: 'I taught a camel to swim.' },
    { fr: 'Mon frigo écrit de la poésie.', en: 'My fridge writes poetry.' }, { fr: "J'ai chatouillé une baleine.", en: 'I tickled a whale.' },
    { fr: 'Les nuages me doivent un dîner.', en: 'The clouds owe me a dinner.' }, { fr: "J'ai vendu la tour Eiffel à un pingouin.", en: 'I sold the Eiffel Tower to a penguin.' },
    { fr: 'Mon réveil a peur de moi.', en: 'My alarm clock is afraid of me.' }, { fr: "J'ai couru plus vite qu'un TGV.", en: 'I ran faster than a bullet train.' },
    { fr: "Une girafe m'a demandé un autographe.", en: 'A giraffe asked me for an autograph.' }, { fr: "J'ai repeint le ciel en bleu moi-même.", en: 'I painted the sky blue myself.' },
    { fr: 'Mon oreiller garde mes secrets.', en: 'My pillow keeps my secrets.' }, { fr: "J'ai battu un singe au concours de grimaces.", en: 'I beat a monkey at pulling faces.' },
    { fr: 'Le fromage me téléphone la nuit.', en: 'The cheese phones me at night.' }, { fr: "J'ai appris à un orage à s'asseoir.", en: 'I trained a storm to sit.' },
    { fr: 'Ma boule connaît toutes les capitales.', en: 'My boule knows every capital city.' }, { fr: "J'ai fait rire une statue.", en: 'I made a statue laugh.' },
    { fr: "Un escargot m'a doublé, je l'ai laissé gagner.", en: 'A snail overtook me; I let it win.' }, { fr: "J'ai un abonnement à la lune.", en: 'I have a subscription to the moon.' },
    { fr: "Mon chapeau parle avec l'accent italien.", en: 'My hat speaks with an Italian accent.' }, { fr: "J'ai chassé le brouillard avec un balai.", en: 'I chased the fog off with a broom.' },
    { fr: 'Les abeilles me demandent conseil.', en: 'The bees ask me for advice.' }, { fr: "J'ai gagné une médaille en dormant.", en: 'I won a medal in my sleep.' },
    { fr: 'Mon pantalon a plus voyagé que moi.', en: 'My trousers have travelled more than me.' }, { fr: "J'ai réconcilié deux pigeons.", en: 'I made peace between two pigeons.' },
    { fr: "Une tempête m'a présenté ses excuses.", en: 'A storm apologised to me.' }, { fr: "J'ai appris le violon à un âne.", en: 'I taught a donkey the violin.' },
    { fr: 'Mon ombre travaille le week-end.', en: 'My shadow works weekends.' }, { fr: "J'ai mangé une horloge, je suis toujours à l'heure.", en: "I ate a clock; I'm always on time." },
    { fr: 'Le vent range ma chambre.', en: 'The wind tidies my room.' }, { fr: "J'ai un cousin qui est une montagne.", en: 'I have a cousin who is a mountain.' },
    { fr: "J'ai battu l'écho à la course.", en: 'I beat the echo in a race.' }, { fr: 'Ma grand-mère a inventé le tonnerre.', en: 'My grandmother invented thunder.' },
    { fr: "J'ai signé un traité avec une guêpe.", en: 'I signed a treaty with a wasp.' }, { fr: 'Mon café me fait la révérence.', en: 'My coffee bows to me.' },
    { fr: "J'ai fait pousser une baguette dans mon jardin.", en: 'I grew a baguette in my garden.' }, { fr: "Un dauphin m'a appris à siffler.", en: 'A dolphin taught me to whistle.' },
    { fr: "J'ai battu un flamant rose aux échecs.", en: 'I beat a flamingo at chess.' }, { fr: 'Ma valise rentre seule à la maison.', en: 'My suitcase comes home on its own.' },
    { fr: "J'ai réparé le soleil avec du scotch.", en: 'I fixed the sun with sticky tape.' }, { fr: "Les montagnes s'écartent quand j'arrive.", en: 'The mountains step aside when I arrive.' },
    { fr: "J'ai un contrat avec l'arc-en-ciel.", en: 'I have a contract with the rainbow.' }, { fr: 'Mon chien a été maire un été.', en: 'My dog was mayor one summer.' },
    { fr: "J'ai fait la course avec mon ombre et j'ai gagné.", en: 'I raced my own shadow and won.' }, { fr: "J'ai appris à un poisson à faire du vélo.", en: 'I taught a fish to ride a bike.' },
    { fr: 'La pluie ne tombe que sur mes rivaux.', en: 'The rain falls only on my rivals.' }, { fr: "J'ai un diplôme de sieste avancée.", en: 'I have a degree in advanced napping.' },
    { fr: "Mon parapluie ne s'ouvre pas sans pourboire.", en: "My umbrella won't open without a tip." }, { fr: "J'ai chatouillé un cactus sans me piquer.", en: 'I tickled a cactus without a scratch.' },
    { fr: "J'ai vu une vache en trottinette.", en: 'I saw a cow on a scooter.' }, { fr: 'Mon miroir me trouve trop beau.', en: 'My mirror finds me too handsome.' },
    { fr: "J'ai apprivoisé un tremblement de terre.", en: 'I tamed an earthquake.' }, { fr: "Une baguette m'a demandé en mariage.", en: 'A baguette proposed to me.' },
    { fr: "J'ai gagné une bataille de boules de neige en été.", en: 'I won a snowball fight in summer.' }, { fr: "Mon réveil chante l'opéra.", en: 'My alarm sings opera.' },
    { fr: "J'ai emprunté la Lune à un ami.", en: 'I borrowed the Moon from a friend.' }, { fr: "Un ours m'appelle 'chef'.", en: "A bear calls me 'boss'." },
    { fr: "J'ai coiffé un lion.", en: "I combed a lion's mane." }, { fr: 'Ma boule refuse de perdre par principe.', en: 'My boule refuses to lose on principle.' },
    { fr: "J'ai appris à voler à une poule.", en: 'I taught a hen to fly.' }, { fr: 'Le tonnerre applaudit mes lancers.', en: 'The thunder applauds my throws.' },
    { fr: "J'ai dîné avec le brouillard.", en: 'I dined with the fog.' }, { fr: 'Mon vélo a fait le tour du monde sans moi.', en: 'My bike toured the world without me.' },
    { fr: "J'ai convaincu un volcan de se calmer.", en: 'I convinced a volcano to calm down.' }, { fr: "Une tortue m'a défié en duel.", en: 'A tortoise challenged me to a duel.' },
    { fr: "J'ai remporté le championnat des rêves.", en: 'I won the dreaming championship.' }, { fr: 'Mon chat dirige une banque.', en: 'My cat runs a bank.' },
    { fr: "J'ai peint les yeux fermés, ça a gagné un prix.", en: 'I painted blindfolded and it won a prize.' }, { fr: "J'ai fait taire une mouette d'un regard.", en: 'I silenced a seagull with one look.' },
    { fr: 'Le soleil me prête ses lunettes.', en: 'The sun lends me its sunglasses.' }, { fr: "J'ai enseigné les maths à une chèvre.", en: 'I taught maths to a goat.' },
    { fr: 'Ma moustache a son propre fan-club.', en: 'My moustache has its own fan club.' }, { fr: "J'ai gagné une course d'escargots à reculons.", en: 'I won a snail race walking backwards.' },
    { fr: "J'ai réveillé un ours poliment.", en: 'I woke a bear politely.' }, { fr: 'Mon canapé a le mal de mer.', en: 'My sofa gets seasick.' },
    { fr: "J'ai remonté la rivière à la nage en lisant le journal.", en: 'I swam upstream reading the newspaper.' }, { fr: "Une comète m'a fait un clin d'œil.", en: 'A comet winked at me.' },
    { fr: "J'ai gagné à la loterie avant de jouer.", en: 'I won the lottery before playing.' }, { fr: 'Mon parapluie a peur de la pluie.', en: 'My umbrella is afraid of the rain.' },
    { fr: "J'ai appris la politesse à un requin.", en: 'I taught a shark manners.' }, { fr: 'Les statues me saluent quand je passe.', en: 'The statues salute me as I pass.' },
    { fr: "J'ai fait du toboggan sur un arc-en-ciel.", en: 'I sledged down a rainbow.' }, { fr: 'Mon grille-pain me raconte des blagues.', en: 'My toaster tells me jokes.' },
    { fr: "J'ai battu le vent à la course.", en: 'I beat the wind in a race.' }, { fr: "Une autruche m'a emprunté mes chaussures.", en: 'An ostrich borrowed my shoes.' },
    { fr: "J'ai appris le tango à un pingouin.", en: 'I taught a penguin the tango.' }, { fr: 'Ma boule a été décorée par le président.', en: 'My boule was decorated by the president.' },
    { fr: "J'ai fait fondre un iceberg d'un sourire.", en: 'I melted an iceberg with a smile.' }, { fr: "Le brouillard s'écarte pour me laisser passer.", en: 'The fog parts to let me through.' },
    { fr: "J'ai gagné un débat contre un perroquet.", en: 'I won a debate against a parrot.' }, { fr: 'Mon ombre a peur du noir.', en: 'My shadow is afraid of the dark.' },
    { fr: "J'ai coursé un guépard et je me suis retenu.", en: 'I raced a cheetah and held back.' }, { fr: "Une méduse m'a serré la main.", en: 'A jellyfish shook my hand.' },
    { fr: "J'ai bâti un pont en spaghettis.", en: 'I built a bridge out of spaghetti.' }, { fr: "Mon horloge accélère quand je m'ennuie.", en: 'My clock speeds up when I get bored.' },
    { fr: "J'ai gagné un concours de silence en parlant.", en: 'I won a silence contest by talking.' }, { fr: "Un crocodile m'a demandé ma recette de soupe.", en: 'A crocodile asked for my soup recipe.' },
    { fr: "J'ai fait la sieste au sommet du mont Blanc.", en: 'I napped on top of Mont Blanc.' }, { fr: 'Mon écharpe part en vacances sans moi.', en: 'My scarf goes on holiday without me.' },
    { fr: "J'ai chatouillé les nuages avec une échelle.", en: 'I tickled the clouds with a ladder.' }, { fr: "J'ai appris à un hérisson à faire des câlins.", en: 'I taught a hedgehog to hug.' },
    { fr: 'Le destin me demande conseil.', en: 'Fate asks me for advice.' }, { fr: "J'ai remonté le temps pour rater le bus.", en: 'I travelled back in time to miss the bus.' },
    { fr: "J'ai un lézard qui gère mes impôts.", en: 'I have a lizard who does my taxes.' }, { fr: 'Ma boule a gagné un César.', en: 'My boule won a film award.' },
    { fr: "J'ai fait la queue devant moi-même.", en: 'I queued up behind myself.' }, { fr: 'Les vagues me font signe de la main.', en: 'The waves wave back at me.' },
    // — dry sarcasm: the ref, thoroughly unimpressed —
    { fr: 'Oh, superbe. Vraiment.', en: 'Oh, lovely. Truly.' }, { fr: 'Quel talent. On applaudit.', en: 'What talent. A round of applause.' },
    { fr: 'Bravo, raté de très loin.', en: 'Bravo, missed by a mile.' }, { fr: 'Magnifique lancer… pour un débutant.', en: 'Magnificent throw… for a beginner.' },
    { fr: "Non, non, vise ailleurs, c'est parfait.", en: "No, no, aim somewhere else, that's perfect." }, { fr: "Impressionnant. Ma grand-mère fait mieux.", en: 'Impressive. My granny does better.' },
    { fr: 'Ah oui, brillant. Vraiment brillant.', en: 'Ah yes, brilliant. Truly brilliant.' }, { fr: "Tu t'es entraîné pour ça ?", en: 'You practised for that?' },
    { fr: 'Génial, encore raté. Quelle constance.', en: 'Great, missed again. Such consistency.' }, { fr: 'Oh là là, quel suspense insoutenable.', en: 'Oh my, what unbearable suspense.' },
    { fr: "C'était… un choix.", en: 'That was… a choice.' }, { fr: 'Formidable. On rentre à la maison ?', en: 'Terrific. Shall we go home now?' },
    { fr: "Chef-d'œuvre. Le Louvre appelle.", en: 'A masterpiece. The Louvre is calling.' }, { fr: "Ne change rien, c'est parfaitement médiocre.", en: "Don't change a thing, it's perfectly mediocre." },
    { fr: 'Ouah. Sans voix. Malheureusement.', en: "Wow. Speechless. Sadly." }, { fr: 'Superbe visée. Le mur te remercie.', en: 'Lovely aim. The wall thanks you.' },
    { fr: 'Tu vises le cochonnet ou le parking ?', en: 'Aiming at the jack or the car park?' }, { fr: "Quelle audace, rater d'aussi près.", en: 'How bold, to miss from so close.' },
    { fr: 'Applaudissements polis.', en: 'Polite applause.' }, { fr: 'Excellent, tu as réveillé la poussière.', en: 'Excellent, you woke up the dust.' },
    { fr: "J'en pleure. De rire.", en: "I'm in tears. Of laughter." }, { fr: 'Un vrai professionnel… du dimanche.', en: 'A true professional… on Sundays.' },
    { fr: "Continue, ça m'occupe.", en: 'Carry on, it passes the time.' }, { fr: 'Sublime. Recommence, pour rire.', en: 'Sublime. Do it again, for a laugh.' },
    { fr: 'Oh, tu tires maintenant ? Courageux.', en: "Oh, shooting now? Brave." }, { fr: 'Le cochonnet est par là, au cas où.', en: 'The jack is over there, just so you know.' },
    { fr: 'Précision chirurgicale… de bûcheron.', en: 'Surgical precision… for a lumberjack.' }, { fr: "Bien joué. Enfin, 'joué'.", en: "Well played. Well, 'played'." },
    { fr: "Tu progresses. Vers l'arrière.", en: "You're improving. Backwards." }, { fr: 'Napoléon serait fier. Ou pas.', en: 'Napoleon would be proud. Or not.' },
  ];
  // Every so often the ref drops the French entirely and BARKS a guttural German command instead — short,
  // shouted, all-caps. (~1 in 4 announcements.) Stored already upper-cased; spoken low-pitched and brisk.
  const GER = [
    { de: 'ACHTUNG!', en: 'Attention!' }, { de: 'VOLLTREFFER!', en: 'Direct hit!' }, { de: 'DANEBEN!', en: 'Missed!' },
    { de: 'DONNERWETTER!', en: 'My word!' }, { de: 'JAWOHL!', en: 'Yes indeed!' }, { de: 'SCHNELLER!', en: 'Faster!' },
    { de: 'UNGLAUBLICH!', en: 'Unbelievable!' }, { de: 'KATASTROPHE!', en: 'Catastrophe!' }, { de: 'WUNDERBAR!', en: 'Wonderful!' },
    { de: 'AUSGEZEICHNET!', en: 'Excellent!' }, { de: 'NEIN, NEIN, NEIN!', en: 'No, no, no!' }, { de: 'SO EIN MIST!', en: 'What rubbish!' },
    { de: 'HIMMEL NOCH MAL!', en: 'Good grief!' }, { de: 'ZACK, ZACK!', en: 'Chop chop!' }, { de: 'MEIN GOTT!', en: 'My God!' },
    { de: 'HERRLICH!', en: 'Glorious!' }, { de: 'PERFEKT!', en: 'Perfect!' }, { de: 'DUMMKOPF!', en: 'Blockhead!' },
    { de: 'NOCH EINMAL!', en: 'Once more!' }, { de: 'HALT!', en: 'Stop!' }, { de: 'FURCHTBAR!', en: 'Dreadful!' },
    { de: 'GANZ SCHLECHT!', en: 'Very bad!' }, { de: 'BRAVO, MEISTER!', en: 'Bravo, master!' }, { de: 'WAS IST DAS?!', en: 'What is that?!' },
    { de: 'GENAU!', en: 'Exactly!' }, { de: 'FANTASTISCH!', en: 'Fantastic!' }, { de: 'RAUS DAMIT!', en: 'Out with it!' },
    { de: 'SITZT!', en: "That's got it!" }, { de: 'ENDLICH!', en: 'Finally!' }, { de: 'HOPPLA!', en: 'Whoops!' },
  ];
  const node = el('ref'), sub = el('subtitle');
  let last = -1, lastG = -1, hideT = 0, frVoices = [], deVoices = [];
  // Grab the French AND German voices the device offers (the set varies by OS/browser).
  const loadVoices = () => { try { const all = speechSynthesis.getVoices();
    frVoices = all.filter((v) => /^fr/i.test(v.lang)); deVoices = all.filter((v) => /^de/i.test(v.lang));
  } catch { /* none */ } };
  try { loadVoices(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadVoices; } catch { /* no TTS */ }
  function speak(text, { german = false } = {}) {
    if (sfx.muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = german ? 'de-DE' : 'fr-FR';
      const pool = german ? deVoices : frVoices;
      if (pool.length) u.voice = pool[(Math.random() * pool.length) | 0];
      if (german) {                            // shouted + guttural: low pitch, brisk, full volume
        u.pitch = 0.3 + Math.random() * 0.3;
        u.rate = 1.0 + Math.random() * 0.25;
        u.volume = 1;
      } else {
        u.pitch = 0.7 + Math.random() * 0.7;   // vary pitch → different ages / genders
        u.rate = 0.85 + Math.random() * 0.35;  // vary tempo → different characters
      }
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch { /* no TTS */ }
  }
  function announce() {
    clearTimeout(hideT);
    if (Math.random() < 0.25) {                 // ~1 in 4: a shouted German bark
      let i; do { i = Math.floor(Math.random() * GER.length); } while (i === lastG && GER.length > 1);
      lastG = i;
      node.innerHTML = `<span class="flag">🇩🇪</span>${GER[i].de}`;
      node.classList.add('show');
      sub.textContent = GER[i].en; sub.classList.add('show');
      hideT = setTimeout(() => { node.classList.remove('show'); sub.classList.remove('show'); }, 2800);
      speak(GER[i].de, { german: true });
      return;
    }
    let i; do { i = Math.floor(Math.random() * PHRASES.length); } while (i === last && PHRASES.length > 1);
    last = i;
    const laugh = Math.random() < 0.18;
    const fr = (laugh ? 'Hon hon hon… ' : '') + PHRASES[i].fr;
    const en = (laugh ? '(chuckles) ' : '') + PHRASES[i].en;
    node.innerHTML = `<span class="flag">🇫🇷</span>${fr}`;
    node.classList.add('show');
    sub.textContent = en; sub.classList.add('show'); // English subtitle at the foot of the screen
    hideT = setTimeout(() => { node.classList.remove('show'); sub.classList.remove('show'); }, 2800);
    speak(fr);
  }
  return { announce };
})();

// --- players + modes --------------------------------------------------------------------------------
// Free-for-all: 2–4 players, each human or AI (closest boule to the jack takes the end; a player scores
// one point per boule of theirs closer than the best of EVERYONE else). AI self-play = all-AI, sit back.
const MODES = {
  ai:      ['human', 'ai'],
  hotseat: ['human', 'human'],
  four:    ['human', 'ai', 'ai', 'ai'],
  watch:   ['ai', 'ai', 'ai', 'ai'],
};

// --- state ------------------------------------------------------------------------------------------
let jack, bodies, boulesLeft, scores, current, mode, phase, aim, aiTimer, settleTimer;
let seq = 0; // turn token — bumped on every turn/phase change so stale timers (AI think/throw) become no-ops
let players = [], perPlayer = 3;
const humanCount = () => players.filter((p) => p.kind === 'human').length;
const playerName = (i) => (players[i].kind === 'human' && humanCount() === 1 && i === 0 ? 'You' : TEAM[i].name);
const turnStatus = () => { const nm = playerName(current); return nm === 'You' ? 'Your throw' : `${nm}'s throw`; };
let impacts = [];  // collision events (contact point + strength) drained each frame for shock-rings + shake
let measureInfo = null;  // during the end's measure: the winner + the boules being counted, for the string overlay
// The spin ball's contact point (like snooker english): side −1..+1 = hook L/R; vert −1..+1 = lob..roll.
let strike = { side: 0, vert: 0 };
const loftFromVert = (v) => clamp(0.5 + v * 0.42, 0.08, 0.95); // draw(down)=lob, follow(up)=roll
const vertFromLoft = (loft) => clamp((loft - 0.5) / 0.42, -1, 1); // inverse — to show the computer's pick on the ball
const shotName = (v) => (v > 0.34 ? 'Roll' : v < -0.34 ? 'Lob' : 'Pitch');
// phase: 'aim' (human to throw) | 'sim' (physics running) | 'measure' | 'over'

function newMatch() {
  seq++; clearTimeout(aiTimer); clearTimeout(settleTimer); // kill any in-flight timers from the old match
  mode = mode || 'ai';
  players = (MODES[mode] || MODES.ai).map((kind) => ({ kind }));
  perPlayer = players.length <= 2 ? 3 : 2; // singles gets 3 boules; a crowded 3–4 player end gets 2 each
  scores = players.map(() => 0);
  el('status').classList.remove('win');
  startEnd(0); // the first player throws the jack
}

function startEnd(starter) {
  seq++; clearTimeout(aiTimer); // fresh end: invalidate any pending AI think/throw
  renderer.setOverhead(false);  // in case a between-shots fly-over was cut short by a restart
  bodies = [];
  boulesLeft = players.map(() => perPlayer);
  current = starter;
  // Place the jack: forward of the throw circle, within the piste, roughly where a real toss lands.
  jack = { x: W / 2 + (Math.random() - 0.5) * 260, y: H * 0.30 + (Math.random() - 0.5) * 120,
    vx: 0, vy: 0, r: JACK_R, team: -1, dead: false, state: 'rest' };
  clampInto(jack);
  phase = 'aim';
  aim = null;
  setStrike(0, 0); // fresh end: spin ball back to centre (this also clears any stale aim preview)
  status(`${turnStatus()} — ${boulesLeft[current]} boules left`);
  syncHud();
  maybeAI();
}

// --- helpers ----------------------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function clampInto(b) { b.x = clamp(b.x, P.x0 + b.r, P.x1 - b.r); b.y = clamp(b.y, P.y0 + b.r, P.y1 - b.r); }
const inBounds = (b) => b.x >= P.x0 && b.x <= P.x1 && b.y >= P.y0 && b.y <= P.y1;
const live = () => bodies.filter((b) => !b.dead);

// Which team owns the boule nearest the jack (or -1 if none on the piste yet).
function holdingTeam() {
  let best = Infinity, team = -1;
  for (const b of live()) { const d = dist(b, jack); if (d < best) { best = d; team = b.team; } }
  return team;
}

// --- throwing -------------------------------------------------------------------------------------
// loft: 0 (high lob) .. 1 (flat roll); spin: -1..+1 (banana curve + landing hook).
function throwTo(landing, loft, spin, team) {
  if (phase !== 'aim') return;   // a boule can only leave from the aim phase — blocks any double / stale throw
  if (boulesLeft[team] <= 0) return;
  seq++;                          // this move consumes the turn: any other pending timer is now void
  // A hand is not a ruler: jitter the intended landing (line + distance) before the boule even leaves.
  // Applies to YOU and the computer alike, so aiming is judgement, not pixel-picking.
  const a0 = Math.atan2(landing.y - THROW.y, landing.x - THROW.x), d0 = dist(THROW, landing);
  const a = a0 + (Math.random() - 0.5) * 2 * AIM_SPREAD_ANG;
  const d = d0 * (1 + (Math.random() - 0.5) * 2 * AIM_SPREAD_DIST);
  landing = reachable({ x: THROW.x + Math.cos(a) * d, y: THROW.y + Math.sin(a) * d });
  boulesLeft[team] -= 1;
  const b = { x: THROW.x, y: THROW.y, vx: 0, vy: 0, r: R, team, dead: false, state: 'air',
    from: { x: THROW.x, y: THROW.y }, to: { x: landing.x, y: landing.y }, t: 0, airLift: 0,
    // a lob hangs in the air longer, a roll is flung low and fast
    flight: Math.max(FLIGHT_MIN, dist(THROW, landing) * FLIGHT_PER_PX) * (1.5 - 0.6 * loft),
    style: loft, spin, curve: spin * CURVE_MAX, arc: arcHeight(loft) };
  bodies.push(b);
  phase = 'sim';
  throwAt = performance.now(); // used to give each move at least ~1.5s to finish before the next begins
  aim = null;
  renderer.react(); // heads in the crowd turn to watch the throw
  syncHud();
}

// When a boule finishes its flight, it lands and (unless a pure lob) runs forward — plus a gravel kick
// and any spin "hook", so it never lands exactly where aimed. `justLanded` cues the renderer's dust puff.
function land(b) {
  b.state = 'ground';
  b.x = b.to.x; b.y = b.to.y;
  b.airLift = 0; b.justLanded = true;
  const ang = Math.atan2(b.to.y - b.from.y, b.to.x - b.from.x);
  const runSpeed = b.style * ROLL_MAX;
  // spin bites the gravel: the run hooks to the side, and a strong spin/lob checks (shortens) the roll
  const spinBias = (b.spin || 0) * 0.5;
  const grab = 1 - 0.28 * Math.abs(b.spin || 0);
  // terrain kick: random angle jitter + speed variance, scaled by roughness (bigger for flatter throws)
  const kickAng = ang + spinBias + (Math.random() - 0.5) * 0.5 * ROUGH * (1.2 - b.style);
  const kickSpd = runSpeed * grab * (1 + (Math.random() - 0.5) * 0.4 * ROUGH) + (Math.random() * 22 * ROUGH);
  b.vx = Math.cos(kickAng) * kickSpd;
  b.vy = Math.sin(kickAng) * kickSpd;
  sfx.thud();
  if (Math.random() < 0.5) referee.announce(); // the French ref pipes up on about half the landings
}

// --- physics --------------------------------------------------------------------------------------
function step(dt) {
  let moving = false;

  // Include the jack (team −1): a knocked jack must roll and settle under friction like any boule —
  // otherwise the velocity the collision gives it is never damped, so it drifts/spins forever.
  for (const b of [jack, ...bodies]) {
    if (b.state === 'air') {
      moving = true;
      b.t += dt * 1000;
      // travel the parabola across the piste, bowing sideways with spin, so the flight is actually SEEN
      const k = Math.min(1, b.t / b.flight), s = Math.sin(k * Math.PI);
      const dx = b.to.x - b.from.x, dy = b.to.y - b.from.y, len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      b.x = b.from.x + dx * k + px * b.curve * s;
      b.y = b.from.y + dy * k + py * b.curve * s;
      b.airLift = s * b.arc;
      if (b.t >= b.flight) land(b);
      continue;
    }
    if (b.dead || b.state === 'rest') continue;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < REST) { b.vx = b.vy = 0; b.state = 'rest'; continue; }
    moving = true;
    // gravel wobble: small random perturbation while rolling
    if (ROUGH) { const w = 26 * ROUGH * dt; b.vx += (Math.random() - 0.5) * w * sp * 0.02; b.vy += (Math.random() - 0.5) * w * sp * 0.02; }
    // rolling friction (constant deceleration)
    const dec = FRICTION * dt, ns = Math.max(0, sp - dec), k = ns / sp;
    b.vx *= k; b.vy *= k;
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (!inBounds(b) && b.team !== -1) { b.dead = true; b.state = 'rest'; b.vx = b.vy = 0; clampInto(b); }
    if (b.team === -1) clampInto(b); // the jack can be knocked but never leaves
  }

  // collisions (equal-mass elastic) among all non-dead, non-air bodies incl. the jack
  const all = [jack, ...bodies].filter((b) => !b.dead && b.state !== 'air');
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], c = all[j];
    const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy) || 0.001, min = a.r + c.r;
    if (d < min) {
      const nx = dx / d, ny = dy / d, overlap = (min - d) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap; c.x += nx * overlap; c.y += ny * overlap;
      const rvx = c.vx - a.vx, rvy = c.vy - a.vy, vn = rvx * nx + rvy * ny;
      if (vn < 0) {
        a.vx += vn * nx; a.vy += vn * ny; c.vx -= vn * nx; c.vy -= vn * ny;
        if (a.state === 'rest') a.state = 'ground'; if (c.state === 'rest') c.state = 'ground';
        const s = Math.min(1, Math.abs(vn) / 300); // how hard the click was → ring size + camera kick
        if (s > 0.1) impacts.push({ x: a.x + nx * a.r, y: a.y + ny * a.r, s });
        if (s > 0.16) sfx.clink(s);
      }
      if (jack.team === -1) clampInto(jack);
    }
  }
  return moving;
}

// Boules must never come to rest overlapping. A tight pack can freeze mid-overlap (separating A↔B shoves
// B into C just as speeds die), so at the moment everything settles we relax all overlaps to just-touching:
// a few iterations of symmetric pairwise circle separation, re-clamped inside the piste each pass. Includes
// the jack. This converges to a valid packing (many boules can touch, none overlap).
function deClump() {
  const items = [jack, ...bodies].filter((b) => !b.dead);
  for (let iter = 0; iter < 20; iter++) {
    let overlapped = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], c = items[j];
        const dx = c.x - a.x, dy = c.y - a.y, min = a.r + c.r;
        let d = Math.hypot(dx, dy);
        if (d < min - 0.01) {
          let nx, ny;
          if (d < 1e-3) { nx = 1; ny = 0; d = 0; } // exactly coincident → split along x
          else { nx = dx / d; ny = dy / d; }
          const push = (min - d) / 2;
          a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
          overlapped = true;
        }
      }
    }
    for (const b of items) clampInto(b); // a shove mustn't put a boule off the piste
    if (!overlapped) break;
  }
}

// --- turn flow ------------------------------------------------------------------------------------
// Distance of a player's CLOSEST boule to the jack (Infinity if they have none down yet).
function nearestDistOf(pi) {
  let best = Infinity;
  for (const b of live()) if (b.team === pi) best = Math.min(best, dist(b, jack));
  return best;
}
// Pétanque's core rule, generalised to N players: whoever does NOT hold the point throws next; among the
// non-holders with boules left, the one lying farthest from the jack (most to gain) goes. −1 → measure.
function nextThrower() {
  const withBoules = players.map((_, i) => i).filter((i) => boulesLeft[i] > 0);
  if (!withBoules.length) return -1;
  const holder = holdingTeam();
  if (holder === -1) return withBoules.includes(current) ? current : withBoules[0];
  const challengers = withBoules.filter((i) => i !== holder);
  const pool = challengers.length ? challengers : withBoules; // only the holder has boules → they play on
  pool.sort((a, b) => nearestDistOf(b) - nearestDistOf(a));
  return pool[0];
}

function afterSettle() {
  seq++; clearTimeout(aiTimer); // new turn: cancel anything left over so exactly one throw can happen
  const next = nextThrower();
  if (next === -1) { measure(); return; }
  current = next;
  phase = 'aim';
  aim = null;
  setStrike(0, 0); // each turn starts from a centred spin ball; an AI sets its own before it throws
  status(`${turnStatus()} — ${boulesLeft[current]} left`);
  syncHud();
  maybeAI();
}

function measure() {
  seq++; clearTimeout(aiTimer); // no AI throws during the measure
  renderer.setOverhead(false);  // back to the ground-level view to run the string out
  phase = 'measure';
  measureInfo = null;
  const pts = live().map((b) => ({ b, team: b.team, d: dist(b, jack) })).sort((a, b) => a.d - b.d);
  if (!pts.length) { status('No boules counted — dead end.'); setTimeout(() => startEnd(current), 1400); return; }
  const winner = pts[0].team;
  const rivalNearest = pts.find((p) => p.team !== winner)?.d ?? Infinity; // best of everyone else
  const counting = pts.filter((p) => p.team === winner && p.d < rivalNearest);
  const points = counting.length;
  const nm = playerName(winner), youWon = players[winner].kind === 'human';
  // run the string out from the jack to the counting boules FIRST; award once the measure has been seen
  measureInfo = { winner, boules: counting.map((p) => p.b) };
  status(`Measuring…  ${nm === 'You' ? 'you' : nm} for ${points}`);
  setTimeout(() => {
    measureInfo = null;
    scores[winner] += points;
    syncHud();
    if (youWon) sfx.chime(); // a little fanfare when a human takes the end
    if (scores[winner] >= 13) {
      phase = 'over';
      status(`${nm === 'You' ? 'You win' : `${nm} wins`} the match 🎉`);
      el('status').classList.toggle('win', youWon);
      syncHud();
      return;
    }
    const verb = nm === 'You' ? 'You win' : `${nm} wins`;
    status(`${verb} the end +${points}. New end…`);
    setTimeout(() => startEnd(winner), 1700);
  }, 1800);
}

// --- simple AI ------------------------------------------------------------------------------------
const isAI = (i) => players[i] && players[i].kind === 'ai';
function maybeAI() {
  clearTimeout(aiTimer);
  if (phase !== 'aim' || !isAI(current)) return;
  const me = current, mySeq = seq; // this exact turn; if seq moves on, our timers no-op
  aiTimer = setTimeout(() => {
    if (seq !== mySeq || phase !== 'aim' || current !== me) return;
    // If someone else holds the point with a boule hugging the jack, sometimes shoot it; else point at the jack.
    const rival = live().filter((b) => b.team !== me).sort((a, b) => dist(a, jack) - dist(b, jack))[0];
    let target, loft, spin;
    if (rival && holdingTeam() !== me && dist(rival, jack) < 34 && Math.random() < 0.45) {
      target = { x: rival.x, y: rival.y }; loft = 0.85; spin = 0;             // shoot: flat and hard
    } else {
      const s = 30; target = { x: jack.x + (Math.random() - 0.5) * s, y: jack.y + (Math.random() - 0.5) * s };
      loft = 0.3 + Math.random() * 0.25; spin = (Math.random() - 0.5) * 0.5;  // point: gentle arc, a little hook
    }
    // show the AI setting its shot on the spin ball, then throw a beat later so you can see it
    setStrike(spin, vertFromLoft(loft));
    aiTimer = setTimeout(() => { if (seq === mySeq && phase === 'aim' && current === me) throwTo(reachable(target), loft, spin, me); }, 520);
  }, 900);
}

// --- input (human aim) ----------------------------------------------------------------------------
// Clamp a desired landing spot to something actually throwable from the circle.
function reachable(pt) {
  let x = clamp(pt.x, P.x0 + R, P.x1 - R);
  let y = clamp(pt.y, P.y0 + R, THROW.y - 34);
  const dx = x - THROW.x, dy = y - THROW.y, d = Math.hypot(dx, dy);
  const md = clamp(d, 70, 480); const a = Math.atan2(dy, dx);
  return { x: THROW.x + Math.cos(a) * md, y: THROW.y + Math.sin(a) * md };
}
const humanTurn = () => phase === 'aim' && players[current] && players[current].kind === 'human' && boulesLeft[current] > 0;

// Turn a pointer position into a throw: DIRECTION from the circle = line; DRAG LENGTH = power → distance.
function aimFrom(pos) {
  const dx = pos.x - THROW.x, dy = pos.y - THROW.y;
  const heading = Math.atan2(dy, dx);
  const power = clamp((Math.hypot(dx, dy) - DRAG_MIN) / (DRAG_MAX - DRAG_MIN), 0, 1);
  const d = DIST_MIN + power * (DIST_MAX - DIST_MIN);
  const landing = reachable({ x: THROW.x + Math.cos(heading) * d, y: THROW.y + Math.sin(heading) * d });
  const loft = loftFromVert(strike.vert), spin = strike.side;
  // arc = the 3D trajectory the overlay draws so you can see the shot before you let go
  return { heading, power, dist: d, landing, loft, spin, shot: shotName(strike.vert), arc: flightArc(THROW, landing, loft, spin) };
}

// Setting up a shot is deliberate: DRAG the piste to set your line + power (the trajectory persists as a
// preview after you let go), fine-tune spin/lob/roll on the ball, then press LAUNCH to actually throw.
let aiming = false;
cv.addEventListener('pointerdown', (ev) => {
  sfx.resume(); // unlock WebAudio on the first user gesture
  if (!humanTurn()) return;
  aiming = true; aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY)); updateLaunch();
  try { cv.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
});
cv.addEventListener('pointermove', (ev) => { if (aiming && humanTurn()) { aim = aimFrom(renderer.screenToGround(ev.clientX, ev.clientY)); updateLaunch(); } });
function endAim() {
  if (!aiming) return;
  aiming = false;
  if (aim && aim.power <= 0.02) aim = null; // a tap, not a drag → no trajectory set
  updateLaunch();
}
cv.addEventListener('pointerup', endAim);
cv.addEventListener('pointercancel', () => { aiming = false; updateLaunch(); });

// Keep the persisted aim's shape (loft/spin/arc) in step with the spin ball as you adjust it.
function recomputeAimShape() {
  if (!aim) return;
  aim.loft = loftFromVert(strike.vert); aim.spin = strike.side; aim.shot = shotName(strike.vert);
  aim.arc = flightArc(THROW, aim.landing, aim.loft, aim.spin);
}
const launchReady = () => humanTurn() && !!aim && aim.power > 0.02;
function updateLaunch() { el('launch').classList.toggle('ready', launchReady()); }
function launch() {
  if (!launchReady()) return;
  sfx.resume();
  const a = aim; aim = null; updateLaunch();
  throwTo(a.landing, a.loft, a.spin, current);
}
el('launch').addEventListener('click', launch);

// --- loop -----------------------------------------------------------------------------------------
// Physics still runs in 2D plan coords; the WebGL renderer draws that state in 3D each frame.
let last = 0, acc = 0, simTime = 0, throwAt = 0;
const OVERHEAD_HOLD_MS = 3000; // settle → pan up (~0.8s) + hold overhead (long dwell to read the distances) before easing back
const PAN_BACK_MS = 1000;      // slow drift home; the turn is handed over as it nears the play view
function frame(ts) {
  const now = ts / 1000; if (!last) last = now; let d = now - last; last = now;
  if (d > 0.05) d = 0.05;
  if (phase === 'sim') {
    acc += d; simTime += d; let moving = false;
    while (acc >= 1 / 120) { moving = step(1 / 120) || moving; acc -= 1 / 120; }
    if (!moving || simTime > 7) { // settled (or safety timeout)
      [jack, ...bodies].forEach((b) => {
        if (b.state === 'air') { b.x = b.to.x; b.y = b.to.y; b.airLift = 0; } // drop any stuck-airborne boule (safety timeout) to its target
        b.state = 'rest'; b.vx = b.vy = 0;
      });
      deClump(); // never leave boules frozen on top of one another
      simTime = 0; acc = 0;
      phase = 'settling';
      clearTimeout(settleTimer);
      // Between shots: swing up to a bird's-eye over the jack so you can read which boule lies nearest, hold
      // it a beat, then ease slowly back down to the play view before the next player throws. This also gives
      // each move at least ~1.5s to play out (fixes rushed/stalled transitions). Skip the fly-over on the very
      // first boule of an end if nothing's actually landed to judge.
      if (live().length) {
        renderer.setOverhead(true, jack);
        settleTimer = setTimeout(() => {
          renderer.setOverhead(false);                        // start drifting back down…
          settleTimer = setTimeout(afterSettle, PAN_BACK_MS);  // …then hand the turn over once we're nearly home
        }, OVERHEAD_HOLD_MS);
      } else {
        const gap = Math.max(300, 1500 - (performance.now() - throwAt));
        settleTimer = setTimeout(afterSettle, gap);
      }
    }
  }
  // b.airLift is set by the physics step during flight; the renderer reads it for the 3D arc.
  updateLaunch(); // keep the Launch button in step with turn/aim state
  renderer.frame({ jack, bodies, aim, aiming, humanTurn, phase, impacts, measure: measureInfo }, d);
  requestAnimationFrame(frame);
}

// --- HUD / controls -------------------------------------------------------------------------------
const dotGrad = (i) => `radial-gradient(circle at 35% 30%, ${TEAM[i].fill[0]}, ${TEAM[i].fill[1]} 70%)`;
function syncHud() {
  el('scores').innerHTML = players.map((p, i) => {
    const spent = perPlayer - boulesLeft[i];
    const dots = Array.from({ length: perPlayer }, (_, k) =>
      `<span class="bd" style="background:${dotGrad(i)}${k < spent ? ';opacity:.2' : ''}"></span>`).join('');
    const tag = p.kind === 'ai' ? '<span class="ai">AI</span>' : '';
    return `<div class="stat${i === current && phase !== 'over' && phase !== 'measure' ? ' turn' : ''}">`
      + patSwatch(i)
      + `<b>${scores[i]}</b><span class="nm">${playerName(i)}</span>${tag}`
      + `<span class="dotrow">${dots}</span></div>`;
  }).join('');
}
const status = (t) => { el('status').classList.remove('win'); el('status').textContent = t; };

el('mode').addEventListener('change', () => { mode = el('mode').value; newMatch(); });
// --- spin ball (snooker-style english) ------------------------------------------------------------
// One steel ball you set the contact point on: up = roll on (follow), down = lob / drop dead (draw),
// out to the side = hook the flight. It feeds `strike`, which aimFrom turns into loft + spin.
const sb = el('spinball'), sbx = sb.getContext('2d');
const SBW = sb.width, SBC = SBW / 2, SBR = SBW / 2 - 12;
function drawSpinBall() {
  sbx.clearRect(0, 0, SBW, SBW);
  const g = sbx.createRadialGradient(SBC - SBR * 0.36, SBC - SBR * 0.42, SBR * 0.12, SBC, SBC, SBR);
  g.addColorStop(0, '#f2f5f8'); g.addColorStop(0.5, '#9fb0bf'); g.addColorStop(1, '#3f4d5a');
  sbx.fillStyle = g; sbx.beginPath(); sbx.arc(SBC, SBC, SBR, 0, 7); sbx.fill();
  sbx.strokeStyle = 'rgba(0,0,0,.45)'; sbx.lineWidth = 1.5; sbx.stroke();
  // reference marks: crosshair + a half-radius ring, so you can gauge how far off-centre the dot sits
  sbx.strokeStyle = 'rgba(18,28,38,.22)'; sbx.lineWidth = 1;
  sbx.beginPath(); sbx.moveTo(SBC - SBR, SBC); sbx.lineTo(SBC + SBR, SBC); sbx.moveTo(SBC, SBC - SBR); sbx.lineTo(SBC, SBC + SBR); sbx.stroke();
  sbx.beginPath(); sbx.arc(SBC, SBC, SBR * 0.5, 0, 7); sbx.stroke();
  sbx.fillStyle = 'rgba(15,25,35,.5)'; sbx.font = '700 10px system-ui, sans-serif'; sbx.textAlign = 'center';
  sbx.fillText('ROLL', SBC, SBC - SBR + 12); sbx.fillText('LOB', SBC, SBC + SBR - 4);
  const dx = SBC + strike.side * SBR, dy = SBC - strike.vert * SBR; // contact dot
  sbx.fillStyle = '#e8663f'; sbx.beginPath(); sbx.arc(dx, dy, 7, 0, 7); sbx.fill();
  sbx.strokeStyle = 'rgba(255,255,255,.9)'; sbx.lineWidth = 2; sbx.stroke();
}
function syncShot() {
  const v = strike.vert, s = strike.side;
  // always two decimals + a fixed-width column, so the readout (and the panel) never resize as you adjust
  el('shot-name').textContent = `${shotName(v)} ${Math.abs(v).toFixed(2)}`;
  el('shot-sub').textContent = `hook ${Math.abs(s) < 0.005 ? '' : (s > 0 ? 'R' : 'L')}${Math.abs(s).toFixed(2)}`;
}
function setStrike(side, vert) {
  const m = Math.hypot(side, vert); if (m > 1) { side /= m; vert /= m; } // clamp the contact point to the ball's edge
  strike = { side, vert };
  drawSpinBall(); syncShot(); recomputeAimShape();
}
function sbFrom(ev) {
  if (!humanTurn()) return; // can't set spin on the computer's turn — the ball shows ITS pick then
  const r = sb.getBoundingClientRect();
  setStrike(((ev.clientX - r.left) * (SBW / r.width) - SBC) / SBR, -((ev.clientY - r.top) * (SBW / r.height) - SBC) / SBR);
}
sb.addEventListener('pointerdown', (ev) => { sb.focus(); try { sb.setPointerCapture(ev.pointerId); } catch { /* ignore */ } sbFrom(ev); });
sb.addEventListener('pointermove', (ev) => { if (ev.buttons) sbFrom(ev); });
sb.addEventListener('dblclick', () => { if (humanTurn()) setStrike(0, 0); });
// arrow keys nudge the contact point for fine adjustment; hold Shift for extra-fine, 0/Home to centre
sb.addEventListener('keydown', (ev) => {
  if (!humanTurn()) return;
  const s = ev.shiftKey ? 0.01 : 0.05;
  if (ev.key === 'ArrowUp') setStrike(strike.side, strike.vert + s);
  else if (ev.key === 'ArrowDown') setStrike(strike.side, strike.vert - s);
  else if (ev.key === 'ArrowRight') setStrike(strike.side + s, strike.vert);
  else if (ev.key === 'ArrowLeft') setStrike(strike.side - s, strike.vert);
  else if (ev.key === '0' || ev.key === 'Home') setStrike(0, 0);
  else return;
  ev.preventDefault();
});
drawSpinBall(); syncShot();

el('measure').addEventListener('click', () => { if (phase === 'aim') measure(); });
el('newgame').addEventListener('click', () => newMatch());

// mute toggle (remembered across sessions)
let startMuted = false; try { startMuted = localStorage.getItem('petanque-muted') === '1'; } catch { /* no storage */ }
if (startMuted) sfx.toggle();
el('mute').textContent = sfx.muted ? '🔇' : '🔊';
el('mute').addEventListener('click', () => {
  const m = sfx.toggle(); sfx.resume();
  el('mute').textContent = m ? '🔇' : '🔊';
  try { localStorage.setItem('petanque-muted', m ? '1' : '0'); } catch { /* no storage */ }
});

el('build').textContent = `Pétanque · v${VERSION}`;
// A shareable link can pick the mode, e.g. ?mode=watch → sit back and watch four AIs play themselves.
let urlMode = null; try { urlMode = new URLSearchParams(location.search).get('mode'); } catch { /* no URL */ }
mode = (urlMode && MODES[urlMode]) ? urlMode : 'ai';
el('mode').value = mode;
newMatch();
requestAnimationFrame(frame);
