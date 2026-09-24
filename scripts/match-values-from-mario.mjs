// Matching conservativo: assegna valore alle lattine di Alessandro (senza valore)
// trovando corrispondenza ESATTA con la collezione di Mario su SKU+produttore+size+paese.
// Zero tolleranza per ambiguita: se una chiave ha valori discordanti o campi mancanti, viene scartata.
// Dry-run di default (nessuna scrittura). APPLY=1 per scrivere su Firebase.
import fs from "fs";

const APPLY = process.env.APPLY === "1";

const alessandro = JSON.parse(fs.readFileSync("C:/Users/Porzia/redmghost-vault/data/alessandro-cans.json", "utf8"));
const mario = JSON.parse(fs.readFileSync("C:/Users/Porzia/redmghost-vault/public/cans.json", "utf8"));

const norm = s => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
const normSku = s => norm(s).replace(/O/g, "0");
const parseVal = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? null : n; };

function keyOf(c, produttore, size, lingua, sku) {
  const s = normSku(sku), p = norm(produttore), sz = norm(size), l = norm(lingua);
  if (!s || !p || p === "?" || !sz || !l) return null; // campi mancanti = troppo rischioso
  return `${s}|${p}|${sz}|${l}`;
}

// costruisci mappa valida da Mario: chiave -> valore (solo se univoco e coerente)
const marioByKey = new Map();
const marioAmbiguous = new Set();
for (const c of mario) {
  const k = keyOf(c, c.produttore, c.size, c.lingua, c.sku);
  if (!k) continue;
  const v = parseVal(c.valore);
  if (v == null || v <= 0) continue;
  if (!marioByKey.has(k)) marioByKey.set(k, { valore: v, nome: c.nome, count: 1 });
  else {
    const existing = marioByKey.get(k);
    if (existing.valore !== v) { marioAmbiguous.add(k); }
    existing.count++;
  }
}
for (const k of marioAmbiguous) marioByKey.delete(k); // scarta chiavi con valori discordanti

console.log(`Chiavi valide (univoche) nel dataset Mario: ${marioByKey.size}`);
console.log(`Chiavi scartate per ambiguita (valori discordanti): ${marioAmbiguous.size}`);

// secondo filtro di sicurezza: somiglianza nome (evita falsi positivi tipo "ultra white" ~ "ultra sunrise"
// che condividono SKU+produttore+size+paese solo perche uscite nello stesso lotto/mese)
const STOPWORDS = new Set(["OLD", "NEW", "ST", "MINI", "TALL", "BOY", "PRICE", "TAG", "PRICEMARK", "TWIST", "TOP", "BOTTOM", "MEGA", "THE", "AND", "WITH", "FOR", "PRINT"]);
const tokenize = s => [...new Set(String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(" ").filter(t => t.length >= 2 && !STOPWORDS.has(t)))];
const MIN_TOKENS = 2; // sotto 2 parole significative il nome e' troppo generico per essere affidabile
function nameSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (Math.min(ta.length, tb.length) < MIN_TOKENS) return 0;
  const setB = new Set(tb);
  const common = ta.filter(t => setB.has(t)).length;
  return common / Math.min(ta.length, tb.length);
}
const NAME_SIM_THRESHOLD = 0.7;

// Esclusione manuale dopo revisione: casi dove la differenza tra i nomi e' un nome proprio
// specifico (titolo gioco, paese) che potrebbe indicare edizioni/varianti diverse, non solo
// una differenza di formattazione. Meglio scartare che rischiare un errore.
const MANUAL_EXCLUDE = new Set([
  "fWyXyLxHEbAPxeGH2MHw", // "killer brew mean bean" vs "JAVA COLD BREW MEAN BEAN" - Killer/Cold potrebbero essere varianti diverse
  "sJD1OQzkObm0Ema8fzjY", // "og assassin's creed origins" vs "OG ASSASSIN'S CREED ITALY" - Origins e' un titolo specifico, Italy un paese
]);

// trova match per le lattine di Alessandro senza valore
const noVal = alessandro.filter(c => !c.valore && c.valore !== 0);
const matches = [];
let rejectedByName = 0;
for (const c of noVal) {
  if (MANUAL_EXCLUDE.has(c.id)) continue;
  const k = keyOf(c, c.produttore, c.size, c.lingua, c.sku);
  if (!k) continue;
  const m = marioByKey.get(k);
  if (!m) continue;
  const sim = nameSimilarity(c.nome, m.nome);
  if (sim < NAME_SIM_THRESHOLD) { rejectedByName++; continue; }
  matches.push({ id: c.id, nomeA: c.nome, nomeM: m.nome, sku: c.sku, produttore: c.produttore, size: c.size, lingua: c.lingua, valore: m.valore, sim: sim.toFixed(2) });
}
console.log(`Scartati per nome troppo diverso (sotto soglia ${NAME_SIM_THRESHOLD}): ${rejectedByName}`);

console.log(`\nLattine Alessandro senza valore: ${noVal.length}`);
console.log(`Match trovati (sicuri, chiave univoca): ${matches.length}`);
console.log(`\n--- Anteprima (primi 40) ---`);
matches.slice(0, 40).forEach(m => console.log(`  [${m.sku}|${m.produttore}|${m.size}|${m.lingua}]  A:"${m.nomeA}"  ~  M:"${m.nomeM}"  ->  €${m.valore}`));

const totalMatchedValue = matches.reduce((s, m) => s + m.valore, 0);
console.log(`\nValore totale che verrebbe assegnato: €${totalMatchedValue.toFixed(2)}`);

fs.writeFileSync("C:/Users/Porzia/redmghost-vault/data/matches.json", JSON.stringify(matches, null, 2));
console.log(`\nReport completo salvato in data/matches.json`);

if (!APPLY) {
  console.log("\n[DRY-RUN] Nessuna scrittura su Firebase. Applica con: APPLY=1 node scripts/match-values-from-mario.mjs");
  process.exit(0);
}

console.log("\n[APPLY] Scrittura valori su Firebase (SOLO campo valore, nessun altro campo toccato)...");
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
