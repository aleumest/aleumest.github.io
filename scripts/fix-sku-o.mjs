// One-time migration: sostituisce la lettera "O" con "0" nel campo SKU di tutte le lattine.
// Dry-run di default (sola lettura). Per applicare davvero: APPLY=1 node scripts/fix-sku-o.mjs
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, updateDoc, doc } from "firebase/firestore";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA02DIbc9rAJwOmRfgphFYMWRcpnDI9xiY",
  authDomain: "monster-vault-2e691.firebaseapp.com",
  projectId: "monster-vault-2e691",
  storageBucket: "monster-vault-2e691.firebasestorage.app",
  messagingSenderId: "349413568305",
  appId: "1:349413568305:web:054c3002470332c9ea8a10",
};

const APPLY = process.env.APPLY === "1";

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

function fixSku(sku) {
  if (sku == null) return sku;
  return String(sku).replace(/O/gi, "0");
}

const snap = await getDocs(collection(db, "cans"));
const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

const toChange = all
  .map(c => ({ id: c.id, nome: c.nome, old: c.sku, neu: fixSku(c.sku) }))
  .filter(c => c.old != null && String(c.old) !== c.neu);

console.log(`Totale lattine: ${all.length}`);
console.log(`SKU con "O" da correggere: ${toChange.length}`);
console.log("--- Anteprima (prime 30) ---");
toChange.slice(0, 30).forEach(c => console.log(`  ${String(c.old).padEnd(12)} -> ${c.neu.padEnd(12)}  (${c.nome || ""})`));

if (!APPLY) {
  console.log("\n[DRY-RUN] Nessuna modifica scritta. Per applicare: APPLY=1 node scripts/fix-sku-o.mjs");
  process.exit(0);
}

console.log("\n[APPLY] Scrittura in corso...");
let done = 0;
for (let i = 0; i < toChange.length; i += 20) {
  const batch = toChange.slice(i, i + 20);
  await Promise.all(batch.map(c => updateDoc(doc(db, "cans", c.id), { sku: c.neu })));
  done += batch.length;
  console.log(`  aggiornate ${done}/${toChange.length}`);
}
console.log(`\n✓ Fatto: ${toChange.length} SKU corretti.`);
process.exit(0);
