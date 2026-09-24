// Matching v2: come v1 ma SENZA vincolo produttore (puo' essere diverso/mancante,
// specialmente per lattine asiatiche dove Alessandro spesso non lo conosce),
// CON vincolo stato piena/vuota (deve combaciare tra le due collezioni),
// e soglia minima valore > 3 EUR. Scrive SOLO il campo valore, mai il produttore.
import fs from "fs";

const APPLY = process.env.APPLY === "1";

const alessandro = JSON.parse(fs.readFileSync("C:/Users/Porzia/redmghost-vault/data/alessandro-cans.json", "utf8"));
const mario = JSON.parse(fs.readFileSync("C:/Users/Porzia/redmghost-vault/public/cans.json", "utf8"));

const norm = s => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
const normSku = s => norm(s).replace(/O/g, "0");
const parseVal = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? null : n; };
const isFullMario = c => /\bFULL\b/i.test(c.note || "");
const isFullAlessandro = c => c.piena_vuota === "FULL";

function keyOf(sku, size, lingua, full) {
  const s = normSku(sku), sz = norm(size), l = norm(lingua);
  if (!s || !sz || !l) return null;
  return `${s}|${sz}|${l}|${full ? "F" : "E"}`;
}

// costruisci mappa valida da Mario: chiave -> valore (solo se univoco e coerente)
const marioByKey = new Map();
const marioAmbiguous = new Set();
for (const c of mario) {
  const v = parseVal(c.valore);
  if (v == null || v <= 3) continue; // soglia minima
  const k = keyOf(c.sku, c.size, c.lingua, isFullMario(c));
  if (!k) continue;
  if (!marioByKey.has(k)) marioByKey.set(k, { valore: v, nome: c.nome, count: 1 });
  else {
    const existing = marioByKey.get(k);
    if (existing.valore !== v) marioAmbiguous.add(k);
    existing.count++;
  }
}
for (const k of marioAmbiguous) marioByKey.delete(k);

console.log(`Chiavi valide (univoche, valore>3) nel dataset Mario: ${marioByKey.size}`);
console.log(`Chiavi scartate per ambiguita: ${marioAmbiguous.size}`);

// filtro somiglianza nome (fondamentale ora che manca il vincolo produttore)
const STOPWORDS = new Set(["OLD", "NEW", "MINI", "TALL", "BOY", "PRICE", "TAG", "PRICEMARK", "TWIST", "MEGA", "THE", "AND", "WITH", "FOR", "PRINT"]);
// NOTA: "ST"/"CT"/"TOP"/"BOTTOM" NON sono stopword: sono codici di apertura/variante
// (Silver Top, Color Top...) che possono distinguere lattine fisicamente diverse.
const tokenize = s => [...new Set(String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter(t => t.length >= 2 && !STOPWORDS.has(t)))];
const MIN_TOKENS = 2;
function nameSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (Math.min(ta.length, tb.length) < MIN_TOKENS) return 0;
  const setB = new Set(tb);
  const common = ta.filter(t => setB.has(t)).length;
  return common / Math.min(ta.length, tb.length);
}
const NAME_SIM_THRESHOLD = 0.7;

// se ENTRAMBI i nomi specificano esplicitamente un codice di apertura/variante e sono
// diversi, e' un mismatch certo (lattine fisicamente diverse) -> scarta sempre.
const OPENING_CODES = ["ST", "CT", "TOP", "BOTTOM"];
function openingMismatch(a, b) {
  const ta = new Set(tokenize(a).concat(String(a ?? "").toUpperCase().match(/\bST\b|\bCT\b/g) || []));
  const tb = new Set(tokenize(b).concat(String(b ?? "").toUpperCase().match(/\bST\b|\bCT\b/g) || []));
  const oa = OPENING_CODES.filter(o => ta.has(o));
  const ob = OPENING_CODES.filter(o => tb.has(o));
  if (!oa.length || !ob.length) return false; // uno dei due non specifica nulla, non e' un conflitto certo
  return !oa.some(o => ob.includes(o)); // nessun codice in comune tra quelli specificati = mismatch
}

const MANUAL_EXCLUDE = new Set([
  "sJD1OQzkObm0Ema8fzjY", // "og assassin's creed origins" vs "OG ASSASSIN'S CREED ITALY" - Origins e' un titolo specifico, Italy un paese
  "6bDhbdiRTz38U243gAWZ", // "rehab white dragon tea" vs "DRAGON REHAB" - WHITE e TEA extra non giustificati, jaccard basso
  "L6UlnSTJhN5TwMVZUhdx", // "HYDRO SUPER SPORT red" vs "HYDRO SUPER SPORT RED DAWG BIG" - DAWG potrebbe essere nome specifico del gusto
  "so0kxS4BDJQMkAnkxSw0", // "lo-carb" (solo) vs "LO-CARB NEW DESIGN" - nome troppo generico, e' una linea non un gusto specifico
]);

const noVal = alessandro.filter(c => !c.valore && c.valore !== 0);
const matches = [];
let rejectedByName = 0, rejectedFullMismatch = 0;
for (const c of noVal) {
  if (MANUAL_EXCLUDE.has(c.id)) continue;
  const full = isFullAlessandro(c);
  const k = keyOf(c.sku, c.size, c.lingua, full);
  if (!k) continue;
  const m = marioByKey.get(k);
  if (!m) continue;
  if (openingMismatch(c.nome, m.nome)) { rejectedByName++; continue; }
  const sim = nameSimilarity(c.nome, m.nome);
  if (sim < NAME_SIM_THRESHOLD) { rejectedByName++; continue; }
  matches.push({ id: c.id, nomeA: c.nome, nomeM: m.nome, sku: c.sku, produttoreA: c.produttore, size: c.size, lingua: c.lingua, full, valore: m.valore, sim: sim.toFixed(2) });
}
console.log(`Scartati per nome troppo diverso: ${rejectedByName}`);
console.log(`\nLattine Alessandro senza valore: ${noVal.length}`);
console.log(`Match trovati (sicuri): ${matches.length}`);
console.log(`\n--- Anteprima (primi 50) ---`);
matches.slice(0, 50).forEach(m => console.log(`  [${m.sku}|${m.size}|${m.lingua}|${m.full ? "FULL" : "-"}] prodA:"${m.produttoreA || "?"}"  A:"${m.nomeA}"  ~  M:"${m.nomeM}"  ->  €${m.valore}`));

const totalVal = matches.reduce((s, m) => s + m.valore, 0);
console.log(`\nValore totale che verrebbe assegnato: €${totalVal.toFixed(2)}`);

fs.writeFileSync("C:/Users/Porzia/redmghost-vault/data/matches-v2.json", JSON.stringify(matches, null, 2));
console.log(`\nReport salvato in data/matches-v2.json`);

if (!APPLY) {
  console.log("\n[DRY-RUN] Nessuna scrittura. Applica con: APPLY=1 node scripts/match-values-v2.mjs");
  process.exit(0);
}

console.log("\n[APPLY] Scrittura SOLO valore su Firebase...");
const { initializeApp } = await import("firebase/app");
const { getFirestore, doc, updateDoc } = await import("firebase/firestore");
const cfg = { apiKey: "AIzaSyA02DIbc9rAJwOmRfgphFYMWRcpnDI9xiY", authDomain: "monster-vault-2e691.firebaseapp.com", projectId: "monster-vault-2e691", storageBucket: "monster-vault-2e691.firebasestorage.app", messagingSenderId: "349413568305", appId: "1:349413568305:web:054c3002470332c9ea8a10" };
const db = getFirestore(initializeApp(cfg));
let done = 0;
for (let i = 0; i < matches.length; i += 15) {
  const batch = matches.slice(i, i + 15);
  await Promise.all(batch.map(m => updateDoc(doc(db, "cans", m.id), { valore: m.valore })));
  done += batch.length;
  console.log(`  ${done}/${matches.length}`);
}
console.log(`\n✓ Fatto: valore scritto su ${matches.length} lattine.`);
process.exit(0);
