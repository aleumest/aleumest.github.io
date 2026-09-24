// Carica su Cloudinary tutte le foto delle lattine esportate da base44 (Can_export.csv).
// Cloudinary fa fetch remoto direttamente dagli URL base44 (nessun download locale).
// Resumable: salva la cache url_base44 -> url_cloudinary in photo-map.json.
import fs from "fs";

const CSV = "C:/Users/Porzia/Downloads/Can_export.csv";
const MAP_FILE = "C:/Users/Porzia/monster-vault/scripts/photo-map.json";
const OUT_FILE = "C:/Users/Porzia/monster-vault/scripts/can-photos.json";
const CLOUD = "dy5c9xbxy", PRESET = "monster-vault";
const CONCURRENCY = 6;

function parseCSV(str) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < str.length; i++) { const c = str[i];
    if (q) { if (c === '"') { if (str[i+1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\r") {} else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// base44 api url -> media cdn url (pubblica, diretta)
function toMediaUrl(u) {
  const m = String(u).match(/\/public\/(.+)$/);
  return m ? "https://media.base44.com/images/public/" + m[1] : u;
}

async function uploadToCloudinary(url) {
  const form = new URLSearchParams();
  form.append("file", url);
  form.append("upload_preset", PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.secure_url) throw new Error(JSON.stringify(data).slice(0, 200));
  return data.secure_url;
}

const rows = parseCSV(fs.readFileSync(CSV, "utf8"));
const hdr = rows[0];
const idx = Object.fromEntries(hdr.map((h, i) => [h, i]));
const data = rows.slice(1).filter(r => r[idx.sku] !== undefined && r.length >= hdr.length - 2);

// costruisci lista lattine con foto
const cans = [];
for (const r of data) {
  let arr = [];
  try { arr = JSON.parse(r[idx.photos] || "[]"); } catch {}
  arr = (Array.isArray(arr) ? arr : []).filter(Boolean).map(toMediaUrl);
  if (arr.length) cans.push({
    tipo_linea: r[idx.tipo_linea], nome: r[idx.nome], sku: r[idx.sku], size: r[idx.size],
    lingua: r[idx.lingua], top_tab: r[idx.top_tab], piena_vuota: r[idx.piena_vuota], apertura: r[idx.apertura],
    srcPhotos: arr,
  });
}

const allUrls = [...new Set(cans.flatMap(c => c.srcPhotos))];
console.log(`Lattine con foto: ${cans.length} | immagini uniche da caricare: ${allUrls.length}`);

const map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : {};
const todo = allUrls.filter(u => !map[u]);
console.log(`Gia caricate: ${allUrls.length - todo.length} | da caricare ora: ${todo.length}`);

let done = 0, failed = 0;
async function worker(list) {
  for (const url of list) {
    try { map[url] = await uploadToCloudinary(url); }
    catch (e) { failed++; console.log("  ERR", url.slice(-40), e.message.slice(0, 80)); }
    done++;
    if (done % 20 === 0) { fs.writeFileSync(MAP_FILE, JSON.stringify(map)); console.log(`  ${done}/${todo.length} (falliti: ${failed})`); }
  }
}
// split in CONCURRENCY code
const chunks = Array.from({ length: CONCURRENCY }, () => []);
todo.forEach((u, i) => chunks[i % CONCURRENCY].push(u));
await Promise.all(chunks.map(worker));
fs.writeFileSync(MAP_FILE, JSON.stringify(map));

// costruisci output finale: lattine -> foto cloudinary
const out = cans.map(c => ({ ...c, photos: c.srcPhotos.map(u => map[u]).filter(Boolean), srcPhotos: undefined }));
fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`\nFATTO. Caricate ${Object.keys(map).length} immagini. Falliti: ${failed}.`);
console.log(`Mapping lattine->foto salvato in ${OUT_FILE}`);
