// Backup giornaliero di tutta la collezione Firestore "cans" (lattine, in vendita
// via is_duplicate, set wishlist via is_set) in un file JSON leggibile dentro
// backups/. Eseguito ogni giorno da .github/workflows/backup.yml, che poi
// committa il file e cancella i backup più vecchi di RETENTION_DAYS.
import fs from "fs";
import path from "path";

const PROJECT_ID = "monster-vault-2e691";
const COLLECTION = "cans";
const RETENTION_DAYS = 7;
const BACKUP_DIR = path.join(process.cwd(), "backups");

function fsValueToPlain(value) {
  if (value == null) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fsValueToPlain);
  if ("mapValue" in value) return fsFieldsToPlain(value.mapValue.fields || {});
  return null;
}

function fsFieldsToPlain(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = fsValueToPlain(value);
  return out;
}

async function fetchAllDocs() {
  let pageToken = "";
  let all = [];
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}?pageSize=300${pageToken ? "&pageToken=" + pageToken : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore fetch failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const docs = json.documents || [];
    all = all.concat(docs.map(d => ({ id: d.name.split("/").pop(), ...fsFieldsToPlain(d.fields || {}) })));
    pageToken = json.nextPageToken || "";
  } while (pageToken);
  return all;
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    const fileDate = new Date(match[1] + "T00:00:00Z").getTime();
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
      console.log("Rimosso backup vecchio:", file);
    }
  }
}

async function run() {
  console.log("Scarico tutti i documenti da Firestore...");
  const docs = await fetchAllDocs();
  console.log(`Scaricati ${docs.length} documenti.`);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(BACKUP_DIR, `${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ exported_at: new Date().toISOString(), count: docs.length, documents: docs }, null, 2));
  console.log("Backup salvato in", outPath);

  pruneOldBackups();
}

run().catch(err => { console.error(err); process.exit(1); });
