// Abbina le foto (can-photos.json) alle lattine su Firebase e scrive il campo photos.
// Scrive SOLO sulle lattine che non hanno gia foto (non sovrascrive nulla).
// Dry-run di default. Applica con: APPLY=1 node scripts/write-photos-to-firebase.mjs
import fs from "fs";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, updateDoc, doc } from "firebase/firestore";

const cfg = { apiKey: "AIzaSyA02DIbc9rAJwOmRfgphFYMWRcpnDI9xiY", authDomain: "monster-vault-2e691.firebaseapp.com", projectId: "monster-vault-2e691", storageBucket: "monster-vault-2e691.firebasestorage.app", messagingSenderId: "349413568305", appId: "1:349413568305:web:054c3002470332c9ea8a10" };
const APPLY = process.env.APPLY === "1";
const db = getFirestore(initializeApp(cfg));

const cans = JSON.parse(fs.readFileSync("C:/Users/Porzia/monster-vault/scripts/can-photos.json", "utf8"));

const clean = s => (s == null ? "" : String(s).trim().replace(/\s+/g, " "));
function normSku(s) {
  if (s == null) return "";
  let x = String(s).trim().toUpperCase().replace(/O/g, "0");
  x = x.replace(/^(\D*)(\d+)/, (m, pre, d) => (d.length >= 2 && parseInt(d.slice(0, 2), 10) > 12) ? pre + "0" + d : m);
  return x.replace(/\s+/g, "");
}
const key8 = c => [clean(c.tipo_linea).toUpperCase(), clean(c.nome).toLowerCase(), normSku(c.sku), clean(c.size).toUpperCase(), clean(c.lingua).toUpperCase(), clean(c.top_tab).toUpperCase(), clean(c.piena_vuota).toUpperCase(), clean(c.apertura).toUpperCase()].join("|");
const key3 = c => [clean(c.tipo_linea).toUpperCase(), clean(c.nome).toLowerCase(), normSku(c.sku)].join("|");
const hasPhotos = d => Array.isArray(d.photos) && d.photos.some(p => p);
const pad4 = a => [a[0] || "", a[1] || "", a[2] || "", a[3] || ""];

const snap = await getDocs(collection(db, "cans"));
const fb = snap.docs.map(d => ({ id: d.id, ...d.data() }));
console.log("Lattine su Firebase:", fb.length, "| lattine con foto da abbinare:", cans.length);

const by8 = new Map(), by3 = new Map();
for (const d of fb) {
  const k8 = key8(d); if (!by8.has(k8)) by8.set(k8, []); by8.get(k8).push(d);
  const k3 = key3(d); if (!by3.has(k3)) by3.set(k3, []); by3.get(k3).push(d);
}

const claimed = new Set();
const avail = list => (list || []).filter(d => !claimed.has(d.id));

let willWrite = 0, alreadyHad = 0, noMatch = 0, viaLoose = 0; const updates = []; const unmatched = [];
for (const c of cans) {
  let target = null;
  const c8 = avail(by8.get(key8(c)));
  if (c8.length) target = c8[0];                       // match esatto (8 campi)
  else { const c3 = avail(by3.get(key3(c))); if (c3.length === 1) { target = c3[0]; viaLoose++; } } // fallback univoco (tipo+nome+sku)
  if (!target) { noMatch++; unmatched.push(`${c.tipo_linea} / ${c.nome} / ${c.sku}`); continue; }
  claimed.add(target.id);
  if (hasPhotos(target)) { alreadyHad++; continue; }
  updates.push({ id: target.id, photos: pad4(c.photos), label: `${c.tipo_linea}/${c.nome}/${c.sku}` });
  willWrite++;
}
console.log("(di cui recuperate col fallback tipo+nome+sku:", viaLoose + ")");

console.log(`\nDa scrivere (foto nuove): ${willWrite}`);
console.log(`Gia avevano foto (saltate): ${alreadyHad}`);
console.log(`Nessun match su Firebase: ${noMatch}`);
if (unmatched.length) { console.log("--- non abbinate (prime 25) ---"); unmatched.slice(0, 25).forEach(u => console.log("  " + u)); }

if (!APPLY) { console.log("\n[DRY-RUN] Nessuna scrittura. Applica con: APPLY=1 node scripts/write-photos-to-firebase.mjs"); process.exit(0); }

console.log("\n[APPLY] Scrittura foto...");
let done = 0;
for (let i = 0; i < updates.length; i += 15) {
  const batch = updates.slice(i, i + 15);
  await Promise.all(batch.map(u => updateDoc(doc(db, "cans", u.id), { photos: u.photos })));
  done += batch.length;
  console.log(`  ${done}/${updates.length}`);
}
console.log(`\n✓ Fatto: foto scritte su ${updates.length} lattine.`);
process.exit(0);
