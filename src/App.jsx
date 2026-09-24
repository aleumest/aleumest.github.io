import { useState, useEffect, useMemo, useRef, useContext, createContext } from "react";
import { createPortal } from "react-dom";
import { Plus, Download, Upload, Database, Map as MapIcon, BarChart2, ChevronLeft, ChevronRight, X, Pencil, Trash2, Camera, ChevronDown, Search, User, LogOut, Sun, Moon, Lock, Unlock, Layers, Globe, Package, PackageCheck, Euro, ImageOff, GlassWater, AlertTriangle, Copy, LayoutGrid, List, Heart, Link2, ChevronUp, GripVertical, HelpCircle, Check, Cookie, Type } from "lucide-react";
import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentSingleTabManager, collection, addDoc, getDocs, updateDoc, deleteDoc, writeBatch, doc, query, orderBy } from "firebase/firestore";
import { getAuth, GoogleAuthProvider, EmailAuthProvider, signInWithPopup, signInWithEmailAndPassword, linkWithCredential, updatePassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from "firebase/auth";

// ─── Firebase Config ──────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA02DIbc9rAJwOmRfgphFYMWRcpnDI9xiY",
  authDomain: "monster-vault-2e691.firebaseapp.com",
  projectId: "monster-vault-2e691",
  storageBucket: "monster-vault-2e691.firebasestorage.app",
  messagingSenderId: "349413568305",
  appId: "1:349413568305:web:054c3002470332c9ea8a10",
};

const CLOUDINARY_CLOUD = "dy5c9xbxy";
const CLOUDINARY_PRESET = "monster-vault";

// ─── XLSX lazy loader ────────────────────────────────────────────────────────
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── Firebase init ────────────────────────────────────────────────────────────
const firebaseApp = initializeApp(FIREBASE_CONFIG);
// Cache locale persistente: sui telefoni, con rete mobile instabile, evita che il
// primo caricamento resti bloccato a tempo indeterminato e rende i caricamenti
// successivi (anche da web app in schermata Home) istantanei da cache.
const db = initializeFirestore(firebaseApp, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();
// Unico account con permessi di modifica: chiunque altro naviga in sola lettura.
const ADMIN_EMAILS = ["alessandromilone05@gmail.com"];

// ─── Firestore helpers ────────────────────────────────────────────────────────
// Su rete mobile instabile getDocs() può restare in sospeso a tempo indeterminato:
// dopo 15s rinunciamo, così la UI può sempre uscire dallo stato di caricamento
// invece di restarci bloccata per sempre.
function withTimeout(promise) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Rete lenta o assente, riprova")), 15000));
  return Promise.race([promise, timeout]);
}

// Il prezzo è nascosto ai visitatori solo lato interfaccia (in base a "admin"),
// non a livello di database: dopo vari problemi causati dallo split in due
// collection separate (letture che fallivano silenziosamente, migrazioni
// parziali, rischio di sovrascritture accidentali), si è tornati a un'unica
// collection "cans" con il prezzo sempre imbustato nel documento. Solo la
// scrittura resta protetta lato Firestore (solo l'admin può scrivere).
async function fbGetCans() {
  const q = query(collection(db, "cans"), orderBy("created_date", "desc"));
  const snap = await withTimeout(getDocs(q));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fbAddCan(data) {
  const ref = await addDoc(collection(db, "cans"), { ...data, created_date: new Date().toISOString() });
  return { id: ref.id, ...data };
}

async function fbUpdateCan(id, data) {
  await updateDoc(doc(db, "cans", id), data);
  return { id, ...data };
}

async function fbDeleteCan(id) {
  await deleteDoc(doc(db, "cans", id));
}

async function fbBulkAdd(cans) {
  const results = [];
  for (let i = 0; i < cans.length; i += 10) {
    const batch = cans.slice(i, i + 10);
    const added = await Promise.all(batch.map(c => addDoc(collection(db, "cans"), { ...c, created_date: new Date().toISOString() })));
    results.push(...added.map((r, j) => ({ id: r.id, ...batch[j] })));
  }
  return results;
}

// Da lanciare una volta sola (pulsante in "Proteggi prezzi nel database" nel
// menu account, ora riusato per l'operazione inversa): riporta nel documento
// pubblico "cans" i prezzi che una versione precedente del sito aveva spostato
// nella collection separata "can_values", poi la ripulisce. Idempotente.
async function fbRestorePricesToPublicCollection() {
  const snap = await getDocs(collection(db, "can_values"));
  const CHUNK = 200;
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + CHUNK)) {
      const valore = d.data().valore;
      if (valore !== undefined && valore !== "" && valore !== null) batch.set(doc(db, "cans", d.id), { valore }, { merge: true });
      batch.delete(doc(db, "can_values", d.id));
    }
    await batch.commit();
  }
  return docs.length;
}

// Da lanciare una volta sola: mette in MAIUSCOLO tutti i campi testuali delle
// lattine già esistenti nel database (aggiunte prima che il salvataggio lo
// facesse in automatico). Aggiorna solo i documenti che ne hanno davvero
// bisogno, e solo i campi che differiscono — idempotente, si può rilanciare
// senza problemi.
const CAN_TEXT_FIELDS = ["tipo_linea", "nome", "sku", "produttore", "size", "lingua", "top_tab", "piena_vuota", "apertura", "note_it", "note_en"];
async function fbUppercaseAllCanFields() {
  const snap = await getDocs(collection(db, "cans"));
  const CHUNK = 200;
  const docs = snap.docs;
  let changed = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = writeBatch(db);
    let hasWrites = false;
    for (const d of docs.slice(i, i + CHUNK)) {
      const data = d.data();
      const updates = {};
      let dirty = false;
      for (const f of CAN_TEXT_FIELDS) {
        const v = data[f];
        if (typeof v === "string" && v !== v.toUpperCase()) { updates[f] = v.toUpperCase(); dirty = true; }
      }
      if (dirty) { batch.update(doc(db, "cans", d.id), updates); hasWrites = true; changed++; }
    }
    if (hasWrites) await batch.commit();
  }
  return changed;
}

// ─── Cloudinary upload ────────────────────────────────────────────────────────
async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Upload fallito");
  return data.secure_url;
}

async function uploadBase64ToCloudinary(dataUrl) {
  const formData = new FormData();
  formData.append("file", dataUrl);
  formData.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, { method: "POST", body: formData });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Upload fallito");
  return data.secure_url;
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    *{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --primary:#22c55e;--primary-dim:rgba(34,197,94,0.12);--primary-border:rgba(34,197,94,0.32);
      --bg:#0b0d10;--card:#14171c;--secondary:#101318;--border:#262b33;
      --muted:#1a1e25;--muted-fg:#8a94a3;--fg:#c7ccd4;--fg-strong:#f2f4f7;--destructive:#ef4444;--yellow:#eab308;
      --shadow:0 8px 28px rgba(0,0,0,0.45);
    }
    :root[data-theme="light"]{
      --primary:#15803d;--primary-dim:rgba(21,128,61,0.12);--primary-border:rgba(21,128,61,0.4);
      --bg:#d6dae1;--card:#ffffff;--secondary:#eef1f5;--border:#aab3c0;
      --muted:#e2e6ec;--muted-fg:#4b5563;--fg:#1f2530;--fg-strong:#05070a;--destructive:#dc2626;--yellow:#b45309;
      --shadow:0 8px 24px rgba(15,23,42,0.18);
    }
    html,body{background:var(--bg);color:var(--fg);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;transition:background 0.2s ease,color 0.2s ease;}
    ::-webkit-scrollbar{width:9px;height:9px;}
    ::-webkit-scrollbar-track{background:transparent;}
    ::-webkit-scrollbar-thumb{background:var(--border);border-radius:6px;}
    ::-webkit-scrollbar-thumb:hover{background:var(--muted-fg);}
    @keyframes spin{to{transform:rotate(360deg);}}
    @keyframes shimmer{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
    @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
    @keyframes modalIn{from{opacity:0;transform:translateY(10px) scale(0.99);}to{opacity:1;transform:translateY(0) scale(1);}}
    @keyframes sheetIn{from{transform:translateY(36px);opacity:0;}to{transform:translateY(0);opacity:1;}}
    @keyframes softPulse{0%,100%{opacity:1;}50%{opacity:0.55;}}
    .pulse-glow{animation:softPulse 2.8s ease-in-out infinite;}
    .spin{animation:spin 0.8s linear infinite;}
    .fade-in{animation:fadeIn 0.2s ease-out;}
    .modal-in{animation:modalIn 0.22s cubic-bezier(0.16,1,0.3,1);}
    .sheet-in{animation:sheetIn 0.28s cubic-bezier(0.16,1,0.3,1);}
    .skeleton{background:linear-gradient(90deg,var(--muted) 25%,var(--secondary) 50%,var(--muted) 75%);background-size:200% 100%;animation:shimmer 1.4s ease-in-out infinite;}
    .can-card{position:relative;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--card);transition:transform 0.16s ease,box-shadow 0.16s ease,border-color 0.16s ease;}
    .can-card:hover{transform:translateY(-2px);z-index:2;box-shadow:var(--shadow);border-color:var(--card-accent,var(--primary-border));}
    .can-card:hover img{transform:scale(1.04);}
    .kpi-card{transition:transform 0.15s ease,box-shadow 0.15s ease,border-color 0.15s ease;}
    .kpi-card:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--primary-border);}
    .no-scrollbar{scrollbar-width:none;-ms-overflow-style:none;}
    .no-scrollbar::-webkit-scrollbar{display:none;width:0;height:0;}
    .can-card img{transition:transform 0.4s cubic-bezier(0.16,1,0.3,1);}
    button{cursor:pointer;font-family:inherit;border-radius:8px;}
    input,select,textarea{font-family:inherit;border-radius:8px;}
    .flag{width:14px;height:10px;object-fit:cover;border-radius:2px;flex-shrink:0;box-shadow:0 0 0 1px rgba(0,0,0,0.15);vertical-align:middle;}
    @media(max-width:640px){
      .detail-grid{grid-template-columns:1fr!important;height:auto!important;}
      .detail-photo-col{height:auto!important;}
      .detail-photo-box{flex:none!important;height:52vw!important;min-height:180px!important;max-height:320px!important;}
      .kpi-grid{grid-template-columns:repeat(2,1fr)!important;gap:8px!important;}
      .kpi-grid>.kpi-card{padding:10px 12px!important;display:flex!important;flex-direction:row!important;align-items:center!important;gap:10px!important;}
      .kpi-icon{width:26px!important;height:26px!important;margin-bottom:0!important;}
      .kpi-text{min-width:0;flex:1;}
      .kpi-value{font-size:18px!important;margin-bottom:1px!important;}
      .kpi-sub{display:none!important;}
      .kpi-wide{grid-column:span 2!important;}
      .filters-grid{grid-template-columns:repeat(2,1fr)!important;}
      .filters-grid>div:first-child{grid-column:1/-1!important;}
      .map-filters-grid{grid-template-columns:repeat(2,1fr)!important;}
      .map-filters-grid .mf-search{order:1;} .map-filters-grid .mf-paese{order:2;} .map-filters-grid .mf-prod{order:3;} .map-filters-grid .mf-size{order:4;}
      .chips-grid{display:grid!important;grid-template-columns:repeat(2,1fr)!important;}
      .chips-grid>button{width:100%;justify-content:center;}
      .stat-section-body{flex-direction:column!important;align-items:center!important;}
      .stat-section-body>div:last-child{width:100%;}
      .map-stats-grid{display:grid!important;grid-template-columns:repeat(2,1fr)!important;justify-content:stretch!important;}
      .map-stats-grid>.kpi-card{justify-content:center;padding:10px 8px!important;}
      .hero-wrap{padding:32px 16px!important;}
      .hero-eyebrow{font-size:9px!important;letter-spacing:0.22em!important;}
      .hero-logo{width:92px!important;height:92px!important;}
      .hero-title{font-size:1.7rem!important;}
      .hero-desc{font-size:12px!important;max-width:300px!important;}
      .hero-stats{width:100%!important;max-width:320px;}
      .hero-stat{padding:12px 6px!important;}
      .hero-stat-num{font-size:18px!important;}
    }
  `}</style>
);

const mono = { fontFamily: "'Inter', system-ui, sans-serif" };
const orbitron = { fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 800, letterSpacing: "-0.01em" };

// ─── i18n ───────────────────────────────────────────────────────────────────
const STRINGS = {
  it: {
    nav_vault: "VAULT", nav_map: "OG MAP", nav_stats: "STATS", nav_duplicates: "IN VENDITA", nav_wishlist: "WISHLIST",
    empty_duplicates: "Nessuna lattina in vendita",
    wishlist_new_set_ph: "Nome nuovo set (es. OG UK anni 90)...", wishlist_create_set: "CREA SET",
    wishlist_name_required: "Scrivi prima un nome per il set", wishlist_set_created: "Set creato ✓",
    wishlist_empty: "Nessun set creato. Crea il tuo primo set qui sopra!",
    wishlist_progress: (a, b) => `${a} / ${b} possedute`,
    wishlist_add_slot: "+ AGGIUNGI LATTINA AL SET", wishlist_slot_label_ph: "Nome/descrizione della lattina...",
    wishlist_country_ph: "— Nazione (opzionale) —",
    wishlist_link_ph: "— Collega a una lattina che possiedi (opzionale) —",
    wishlist_missing_tag: "MANCANTE", wishlist_owned_tag: "POSSEDUTA",
    wishlist_delete_set: "ELIMINA SET", wishlist_confirm_delete_set: "CONFERMI? TOCCA DI NUOVO",
    wishlist_rename: "RINOMINA", wishlist_cancel: "ANNULLA", wishlist_save: "SALVA",
    wishlist_remove_slot: "RIMUOVI DAL SET", wishlist_unlink: "SCOLLEGA LATTINA",
    wishlist_no_slots: "Nessuna lattina in questo set. Aggiungine una qui sotto.",
    wishlist_summary: (n, a, b) => `${n} set · ${a} / ${b} possedute in totale`,
    hero_eyebrow: "MONSTER ENERGY ARCHIVE", hero_eyebrow_since: "DAL 2019", hero_tagline: "THE COLLECTION",
    hero_desc: "Il mio archivio Monster Energy: ogni lattina catalogata e mappata nel mondo.",
    hero_lattine: "LATTINE", hero_valore: "VALORE", hero_paesi: "PAESI",
    hero_new: n => `+${n} nuove questo mese`, hero_no_new: "nessuna nuova lattina questo mese",
    hero_enter: "ENTRA NEL VAULT",
    header_lattine: "LATTINE", header_admin: " Admin", header_guest: " Guest", header_import: " Import", header_export: " Export", header_add: " Aggiungi",
    header_esci: "Esci", theme_title: "Tema chiaro / scuro", lang_title: "Lingua / Language", header_help: "Come funziona il sito",
    search_ph: "Cerca nome, SKU...", filter_all_lines: "TUTTE LE LINEE", filter_all_sizes: "TUTTI I SIZE", filter_producers: "PRODUTTORI", filter_nation: "NAZIONE",
    chip_full: "PIENE", chip_empty: "VUOTE", chip_photo: "CON FOTO", chip_no_photo: "SENZA FOTO", chip_value: "CON VALORE", chip_no_value: "SENZA VALORE",
    sort_ph: "ORDINA", reset: "RESET",
    sort_default: "ORDINE ORIGINALE", sort_name_az: "NOME A→Z", sort_name_za: "NOME Z→A", sort_sku_asc: "SKU 0→9 (più vecchio)", sort_sku_desc: "SKU 9→0 (più recente)", sort_tipo: "LINEA", sort_recent: "RECENTI (ultime aggiunte)", sort_valore_desc: "VALORE ↓ (più alto)", sort_valore_asc: "VALORE ↑ (più basso)",
    of_total: (a, b) => `${a} / ${b}`,
    empty_state: "Nessuna lattina trovata", load_more: "CARICA ALTRI ▼",
    detail_prev: "PREV", detail_next: "NEXT", detail_can_fallback: "LATTINA",
    field_tipo_linea: "TIPO LINEA", field_nome: "NOME", field_sku: "SKU", field_produttore: "PRODUTTORE", field_size: "SIZE", field_lingua: "LINGUA / PAESE", field_top_tab: "TOP / TAB", field_pv: "PIENA / VUOTA", field_apertura: "APERTURA", field_valore: "VALORE STIMATO", field_condizione: "CONDIZIONE", field_note: "NOTE",
    modifica: "MODIFICA", elimina: "ELIMINA", confirm_delete: "CONFERMI? TOCCA DI NUOVO",
    edit_title_new: "AGGIUNGI LATTINA", edit_title_edit: "MODIFICA LATTINA", edit_photos_label: "FOTO (4 SLOT) — Cloudinary", edit_photo_n: n => `FOTO ${n}`,
    edit_tipo_linea: "TIPO LINEA *", edit_valore_eur: "VALORE STIMATO (€)", edit_none: "— Nessuno —", edit_cancel: "ANNULLA", edit_save: "SALVA", edit_saving: "TRADUCO...", edit_note_ph: "Note libere sulla lattina (graffi, edizione speciale, provenienza...)",
    preview_title: "ANTEPRIMA — così apparirà nella griglia", preview_shown_as: "Così verrà mostrata", preview_crop_note: "La foto viene ritagliata in formato quadrato.", preview_center: "Centra il soggetto nel riquadro verde.", preview_retry: "RIFARE", preview_use: "✓ USA QUESTA FOTO",
    kpi_totale: "TOTALE", kpi_totale_sub: "lattine in collezione", kpi_linee: "LINEE", kpi_paesi: "PAESI", kpi_paesi_sub: "lingue / paesi", kpi_con_foto: "CON FOTO", kpi_vuote: "VUOTE", kpi_piene: "PIENE", kpi_valore: "VALORE STIMATO", kpi_pct_total: pct => `${pct}% del totale`, kpi_valued: n => `${n} lattine valutate`,
    coverage_title: "COPERTURA DATI", coverage_foto: "FOTO", coverage_valore: "VALORE", coverage_condizione: "CONDIZIONE", coverage_note: "NOTE",
    map_loading: "Caricamento mappa...", map_original: "ORIGINAL", map_missing_title: n => `PAESI MANCANTI (${n})`,
    map_section_missing: n => `MANCANTI (${n})`, map_section_found: n => `TROVATE MA MANCANTI (${n})`, map_section_ontheway: n => `IN ARRIVO (${n})`,
    map_search_ph: "Cerca per nome, SKU, paese...", map_ph_paese: "— Paese —", map_ph_size: "— Size —",
    see_photo: "VEDI FOTO", no_photo: "NO FOTO",
    ref_photos_title: n => `${n} — foto di riferimento`, ref_photos_zoom_hint: "Tocca la foto per zoomare",
    map_missing: "⚠ MANCANTE", map_partial: "⚡ PARZIALE", map_cans_n: n => `${n} lattine`, map_more: n => `+${n} altre`,
    toast_photo_uploaded: "Foto caricata su Cloudinary!", toast_upload_err: m => `Errore upload: ${m}`,
    toast_tipo_required: "TIPO LINEA è obbligatorio",
    toast_can_updated: "Lattina aggiornata ✓", toast_can_added: "Lattina aggiunta ✓", toast_save_err: m => `Errore salvataggio: ${m}`,
    toast_can_deleted: "Lattina eliminata", toast_delete_err: m => `Errore eliminazione: ${m}`,
    toast_export_done: "Export completato ✓", toast_export_err: "Errore export",
    toast_load_err: m => `Errore caricamento: ${m}`,
    toast_login_ok: "Accesso admin effettuato ✓", toast_login_err: m => `Errore accesso: ${m}`,
    toast_login_wrong_pw: "Password errata",
    email_login_title: "ACCESSO ADMIN", email_login_desc: "Accesso da web app: inserisci la password admin.",
    email_login_password_ph: "Password", email_login_submit: "Accedi", email_login_cancel: "Annulla",
    header_set_password: "Imposta password web app", toast_set_password_ok: "Password impostata ✓",
    header_migrate_prices: "Ripristina prezzi nel documento", toast_migrate_ok: n => n > 0 ? `Prezzi ripristinati: ${n} lattine ✓` : "Niente da ripristinare, già tutto a posto ✓",
    header_uppercase_data: "Uniforma dati in MAIUSCOLO", toast_uppercase_ok: n => n > 0 ? `Dati uniformati: ${n} lattine ✓` : "Niente da uniformare, già tutto in maiuscolo ✓",
    set_password_title: "PASSWORD WEB APP", set_password_desc: "Imposta una password per accedere come admin dalla web app in schermata Home (accesso separato da Google, resta lo stesso account).",
    set_password_new_ph: "Nuova password", set_password_confirm_ph: "Ripeti password", set_password_mismatch: "Le due password non coincidono", set_password_submit: "Salva",
    views_label: n => `★ VISTE${n ? ` (${n})` : ""}`, views_save: "+ SALVA VISTA ATTUALE", views_empty: "Nessuna vista salvata", views_prompt: "Nome della vista:", views_saved: "Vista salvata ✓",
    import_title: "IMPORTA XLSX → FIREBASE", import_drop: "Trascina il file Excel qui", import_or_click: "oppure clicca per selezionare", import_note: "I dati vengono salvati su Firebase. Le foto si aggiungono dopo, senza limiti.",
    pv_full: "PIENA", pv_empty: "VUOTA",
    timeline_title: "TIMELINE — LATTINE PER ANNO (DA SKU)",
    timeline_trend_label: y => `rispetto al ${y}`,
    stat_voci_tot: (n, t) => `${n} VOCI · ${t} TOT`, show_less: "▲ MOSTRA MENO", show_more: n => `▼ +${n} ALTRI`,
    map_click_hint: "Clicca un paese colorato per filtrare le lattine", map_filtering_by: name => `Filtro mappa: ${name}`,
    view_grid_title: "Vista griglia", view_list_title: "Vista elenco",
    col_name: "NOME", col_sku: "SKU", col_manufacturer: "PRODUTTORE", col_country: "NAZIONE", col_size: "SIZE", col_toptab: "TOP/TAB", col_status: "STATO",
    cookie_text: "Salviamo solo le tue preferenze (lingua, tema, vista) nel browser di chi visita il sito. Niente pubblicità, niente tracciamento di terzi — per l'admin serve anche a restare connesso senza rifare il login ogni volta.",
    cookie_accept: "Capito",
    rules_title: "MONSTER VAULT",
    rules_kicker: "PRIMA DI ENTRARE",
    rules_intro: "È la mia collezione personale di lattine Monster Energy. Puoi sfogliarla liberamente — solo io posso modificarla.",
    rules_section_view: "COSA PUOI FARE",
    rules_view_1: "Sfogliare tutta la collezione (VAULT) con filtri, ricerca e vista a griglia o elenco.",
    rules_view_2: "Esplorare la OG MAP: la mappa del mondo con i paesi da cui arrivano le lattine — clicca un paese colorato per vedere solo le sue lattine, e guarda i paesi ancora mancanti (in rosso) con le foto di riferimento.",
    rules_view_3: "Guardare le STATS: numeri e grafici sulla collezione.",
    rules_view_4: "Vedere le lattine IN VENDITA, con il relativo prezzo.",
    rules_view_5: "Curiosare nella WISHLIST: i set che sto cercando di completare — verde = lattina già trovata, rosso = ancora mancante.",
    rules_section_hidden: "COSA NON PUOI VEDERE",
    rules_hidden_1: "Prezzi e valore stimato delle lattine NON in vendita, e il valore totale della collezione: li vedo solo io.",
    rules_section_locked: "COSA POSSO FARE SOLO IO",
    rules_locked_1: "Aggiungere, modificare o eliminare lattine, set o inserzioni.",
    rules_locked_2: "Importare/esportare dati.",
    rules_close: "HO CAPITO, INIZIA A ESPLORARE",
  },
  en: {
    nav_vault: "VAULT", nav_map: "OG MAP", nav_stats: "STATS", nav_duplicates: "FOR SALE", nav_wishlist: "WISHLIST",
    empty_duplicates: "No cans for sale",
    wishlist_new_set_ph: "New set name (e.g. OG UK 90s)...", wishlist_create_set: "CREATE SET",
    wishlist_name_required: "Type a name for the set first", wishlist_set_created: "Set created ✓",
    wishlist_empty: "No sets yet. Create your first one above!",
    wishlist_progress: (a, b) => `${a} / ${b} owned`,
    wishlist_add_slot: "+ ADD CAN TO SET", wishlist_slot_label_ph: "Name/description of the can...",
    wishlist_country_ph: "— Country (optional) —",
    wishlist_link_ph: "— Link to a can you already own (optional) —",
    wishlist_missing_tag: "MISSING", wishlist_owned_tag: "OWNED",
    wishlist_delete_set: "DELETE SET", wishlist_confirm_delete_set: "CONFIRM? TAP AGAIN",
    wishlist_rename: "RENAME", wishlist_cancel: "CANCEL", wishlist_save: "SAVE",
    wishlist_remove_slot: "REMOVE FROM SET", wishlist_unlink: "UNLINK CAN",
    wishlist_no_slots: "No cans in this set yet. Add one below.",
    wishlist_summary: (n, a, b) => `${n} sets · ${a} / ${b} owned in total`,
    hero_eyebrow: "MONSTER ENERGY ARCHIVE", hero_eyebrow_since: "SINCE 2019", hero_tagline: "THE COLLECTION",
    hero_desc: "My Monster Energy archive: every can catalogued and mapped around the world.",
    hero_lattine: "CANS", hero_valore: "VALUE", hero_paesi: "COUNTRIES",
    hero_new: n => `+${n} new this month`, hero_no_new: "no new cans this month",
    hero_enter: "ENTER THE VAULT",
    header_lattine: "CANS", header_admin: " Admin", header_guest: " Guest", header_import: " Import", header_export: " Export", header_add: " Add",
    header_esci: "Sign out", theme_title: "Light / dark theme", lang_title: "Lingua / Language", header_help: "How the site works",
    search_ph: "Search name, SKU...", filter_all_lines: "ALL LINES", filter_all_sizes: "ALL SIZES", filter_producers: "MANUFACTURERS", filter_nation: "COUNTRY",
    chip_full: "FULL", chip_empty: "EMPTY", chip_photo: "WITH PHOTO", chip_no_photo: "NO PHOTO", chip_value: "WITH VALUE", chip_no_value: "NO VALUE",
    sort_ph: "SORT", reset: "RESET",
    sort_default: "ORIGINAL ORDER", sort_name_az: "NAME A→Z", sort_name_za: "NAME Z→A", sort_sku_asc: "SKU 0→9 (oldest)", sort_sku_desc: "SKU 9→0 (newest)", sort_tipo: "LINE", sort_recent: "RECENT (latest added)", sort_valore_desc: "VALUE ↓ (highest)", sort_valore_asc: "VALUE ↑ (lowest)",
    of_total: (a, b) => `${a} / ${b}`,
    empty_state: "No cans found", load_more: "LOAD MORE ▼",
    detail_prev: "PREV", detail_next: "NEXT", detail_can_fallback: "CAN",
    field_tipo_linea: "LINE TYPE", field_nome: "NAME", field_sku: "SKU", field_produttore: "MANUFACTURER", field_size: "SIZE", field_lingua: "LANGUAGE / COUNTRY", field_top_tab: "TOP / TAB", field_pv: "FULL / EMPTY", field_apertura: "OPENING", field_valore: "ESTIMATED VALUE", field_condizione: "CONDITION", field_note: "NOTES",
    modifica: "EDIT", elimina: "DELETE", confirm_delete: "CONFIRM? TAP AGAIN",
    edit_title_new: "ADD CAN", edit_title_edit: "EDIT CAN", edit_photos_label: "PHOTOS (4 SLOTS) — Cloudinary", edit_photo_n: n => `PHOTO ${n}`,
    edit_tipo_linea: "LINE TYPE *", edit_valore_eur: "ESTIMATED VALUE (€)", edit_none: "— None —", edit_cancel: "CANCEL", edit_save: "SAVE", edit_saving: "TRANSLATING...", edit_note_ph: "Free notes about the can (scratches, special edition, provenance...)",
    preview_title: "PREVIEW — this is how it will look in the grid", preview_shown_as: "This is how it will be shown", preview_crop_note: "The photo is cropped to a square.", preview_center: "Center the subject in the green frame.", preview_retry: "RETAKE", preview_use: "✓ USE THIS PHOTO",
    kpi_totale: "TOTAL", kpi_totale_sub: "cans in collection", kpi_linee: "LINES", kpi_paesi: "COUNTRIES", kpi_paesi_sub: "languages / countries", kpi_con_foto: "WITH PHOTO", kpi_vuote: "EMPTY", kpi_piene: "FULL", kpi_valore: "ESTIMATED VALUE", kpi_pct_total: pct => `${pct}% of total`, kpi_valued: n => `${n} cans valued`,
    coverage_title: "DATA COVERAGE", coverage_foto: "PHOTO", coverage_valore: "VALUE", coverage_condizione: "CONDITION", coverage_note: "NOTES",
    map_loading: "Loading map...", map_original: "ORIGINAL", map_missing_title: n => `MISSING COUNTRIES (${n})`,
    map_section_missing: n => `MISSING (${n})`, map_section_found: n => `FOUND BUT MISSING (${n})`, map_section_ontheway: n => `ON THE WAY (${n})`,
    map_search_ph: "Search by name, SKU, country...", map_ph_paese: "— Country —", map_ph_size: "— Size —",
    see_photo: "SEE PHOTO", no_photo: "NO PHOTO",
    ref_photos_title: n => `${n} — reference photos`, ref_photos_zoom_hint: "Tap the photo to zoom",
    map_missing: "⚠ MISSING", map_partial: "⚡ PARTIAL", map_cans_n: n => `${n} cans`, map_more: n => `+${n} more`,
    toast_photo_uploaded: "Photo uploaded to Cloudinary!", toast_upload_err: m => `Upload error: ${m}`,
    toast_tipo_required: "LINE TYPE is required",
    toast_can_updated: "Can updated ✓", toast_can_added: "Can added ✓", toast_save_err: m => `Save error: ${m}`,
    toast_can_deleted: "Can deleted", toast_delete_err: m => `Delete error: ${m}`,
    toast_export_done: "Export complete ✓", toast_export_err: "Export error",
    toast_load_err: m => `Loading error: ${m}`,
    toast_login_ok: "Signed in as admin ✓", toast_login_err: m => `Sign-in error: ${m}`,
    toast_login_wrong_pw: "Wrong password",
    email_login_title: "ADMIN SIGN-IN", email_login_desc: "Signing in from the web app: enter the admin password.",
    email_login_password_ph: "Password", email_login_submit: "Sign in", email_login_cancel: "Cancel",
    header_set_password: "Set web app password", toast_set_password_ok: "Password set ✓",
    header_migrate_prices: "Restore prices to document", toast_migrate_ok: n => n > 0 ? `Prices restored: ${n} cans ✓` : "Nothing to restore, already up to date ✓",
    header_uppercase_data: "Uppercase all can data", toast_uppercase_ok: n => n > 0 ? `Data uppercased: ${n} cans ✓` : "Nothing to fix, already all uppercase ✓",
    set_password_title: "WEB APP PASSWORD", set_password_desc: "Set a password to sign in as admin from the home-screen web app (a separate sign-in method, same account as Google).",
    set_password_new_ph: "New password", set_password_confirm_ph: "Confirm password", set_password_mismatch: "Passwords don't match", set_password_submit: "Save",
    views_label: n => `★ VIEWS${n ? ` (${n})` : ""}`, views_save: "+ SAVE CURRENT VIEW", views_empty: "No saved views", views_prompt: "View name:", views_saved: "View saved ✓",
    import_title: "IMPORT XLSX → FIREBASE", import_drop: "Drag the Excel file here", import_or_click: "or click to select", import_note: "Data is saved to Firebase. Photos can be added later, without limits.",
    pv_full: "FULL", pv_empty: "EMPTY",
    timeline_title: "TIMELINE — CANS PER YEAR (FROM SKU)",
    timeline_trend_label: y => `vs ${y}`,
    stat_voci_tot: (n, t) => `${n} ITEMS · ${t} TOT`, show_less: "▲ SHOW LESS", show_more: n => `▼ +${n} MORE`,
    map_click_hint: "Click a colored country to filter its cans", map_filtering_by: name => `Map filter: ${name}`,
    view_grid_title: "Grid view", view_list_title: "List view",
    col_name: "NAME", col_sku: "SKU", col_manufacturer: "MANUFACTURER", col_country: "COUNTRY", col_size: "SIZE", col_toptab: "TOP/TAB", col_status: "STATUS",
    cookie_text: "We only save your preferences (language, theme, view) in your browser. No ads, no third-party tracking — for the admin it also means staying signed in without logging in again.",
    cookie_accept: "Got it",
    rules_title: "MONSTER VAULT",
    rules_kicker: "BEFORE YOU GO IN",
    rules_intro: "This is my personal Monster Energy can collection. Browse it freely — only I can edit it.",
    rules_section_view: "WHAT YOU CAN DO",
    rules_view_1: "Browse the whole collection (VAULT) with filters, search, and grid or list view.",
    rules_view_2: "Explore the OG MAP: a world map of the countries the cans come from — click a colored country to filter its cans, and see countries still missing (in red) with reference photos.",
    rules_view_3: "Check out STATS: numbers and charts about the collection.",
    rules_view_4: "View the cans FOR SALE, with their price.",
    rules_view_5: "Browse the WISHLIST: the sets I'm trying to complete — green = already found, red = still missing.",
    rules_section_hidden: "WHAT YOU CAN'T SEE",
    rules_hidden_1: "Prices and estimated value of cans NOT for sale, and the collection's total value: only I can see them.",
    rules_section_locked: "WHAT ONLY I CAN DO",
    rules_locked_1: "Adding, editing or deleting cans, sets or listings.",
    rules_locked_2: "Importing/exporting data.",
    rules_close: "GOT IT, START EXPLORING",
  },
};

const LangContext = createContext({ lang: "it", setLang: () => {}, t: k => k });
function useLang() { return useContext(LangContext); }
function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem("vault_lang") || "it");
  const setLang = l => { setLangState(l); localStorage.setItem("vault_lang", l); };
  const t = (key, ...args) => {
    const entry = STRINGS[lang]?.[key] ?? STRINGS.it[key] ?? key;
    return typeof entry === "function" ? entry(...args) : entry;
  };
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}
function LangToggle({ className = "" }) {
  const { lang, setLang, t } = useLang();
  return (
    <button className={className} title={t("lang_title")} onClick={() => setLang(lang === "it" ? "en" : "it")}
      style={{ ...mono, border: "1px solid var(--border)", color: "var(--muted-fg)", height: 34, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "transparent", borderRadius: 8, fontSize: 10, fontWeight: 700, letterSpacing: "0.02em" }}>
      <img className="hdr-lang-flag" src={`https://flagcdn.com/20x15/${lang === "it" ? "it" : "gb"}.png`} alt="" style={{ width: 16, height: 12, borderRadius: 2, objectFit: "cover", flexShrink: 0 }} onError={e => e.target.style.display='none'} />
      {lang === "it" ? "IT" : "EN"}
    </button>
  );
}
// Nome paese localizzato a partire dal valore grezzo salvato (già perlopiù in inglese)
const ISO_TO_NAME_IT = { IT:"Italia",US:"USA",DE:"Germania",ES:"Spagna",FR:"Francia",GB:"Regno Unito",NL:"Paesi Bassi",BE:"Belgio",AT:"Austria",CH:"Svizzera",PT:"Portogallo",SE:"Svezia",NO:"Norvegia",FI:"Finlandia",DK:"Danimarca",PL:"Polonia",CZ:"Rep. Ceca",HU:"Ungheria",RO:"Romania",BG:"Bulgaria",GR:"Grecia",TR:"Turchia",RU:"Russia",UA:"Ucraina",JP:"Giappone",CN:"Cina",KR:"Corea del Sud",AU:"Australia",BR:"Brasile",MX:"Messico",CA:"Canada",AR:"Argentina",CL:"Cile",ZA:"Sudafrica",IN:"India",IE:"Irlanda",HR:"Croazia",SK:"Slovacchia",SI:"Slovenia",RS:"Serbia",LU:"Lussemburgo",MT:"Malta",CY:"Cipro",EE:"Estonia",LV:"Lettonia",LT:"Lituania",BY:"Bielorussia",KZ:"Kazakistan",IL:"Israele",AE:"Emirati Arabi",SA:"Arabia Saudita",EG:"Egitto",MA:"Marocco",NG:"Nigeria",KE:"Kenya",NZ:"Nuova Zelanda",TH:"Tailandia",VN:"Vietnam",PH:"Filippine",ID:"Indonesia",MY:"Malesia",SG:"Singapore",CO:"Colombia",PE:"Perù",EC:"Ecuador",VE:"Venezuela",IS:"Islanda",MK:"Macedonia del N.",AL:"Albania",HK:"Hong Kong",TW:"Taiwan",LK:"Sri Lanka",GE:"Georgia",JO:"Giordania",QA:"Qatar",TZ:"Tanzania",JM:"Giamaica",MD:"Moldavia",KH:"Cambogia",DO:"Rep. Dominicana",CR:"Costa Rica",GT:"Guatemala",UY:"Uruguay",BO:"Bolivia",TT:"Trinidad",AZ:"Azerbaigian",AF:"Afghanistan",PY:"Paraguay",ME:"Montenegro",XK:"Kosovo",OM:"Oman",BH:"Bahrain" };

// ─── Colore per linea (color-coding card) ───────────────────────────────────────
const LINE_PALETTE = ["#00ff41", "#00e5ff", "#ff6600", "#ff69b4", "#a855f7", "#ffd700", "#ff4444", "#00bfff", "#7fff00", "#40e0d0", "#ff1493", "#ffa07a", "#98fb98", "#dda0dd"];
function lineColor(s) {
  if (!s) return "#00ff41";
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LINE_PALETTE[h % LINE_PALETTE.length];
}
// ─── Bandiera nazione (immagine flagcdn con fallback testo ISO) ──────────────────
function flagIsos(lingua) {
  if (!lingua) return [];
  const up = String(lingua).toUpperCase().trim();
  if (up.includes("CARIB")) return ["🏝️"];
  if (up === "BENELUX") return ["NL", "BE", "LU"];
  return normalizeLinguaAll(lingua);
}
function Flag({ lingua }) {
  const [err, setErr] = useState({});
  const isos = flagIsos(lingua);
  if (!isos.length) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
      {isos.map((iso, i) => (
        <span key={iso + i} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          {i > 0 && <span style={{ color: "var(--muted-fg)", fontSize: 10 }}>/</span>}
          {iso === "🏝️"
            ? <span style={{ fontSize: 13, lineHeight: 1 }}>🏝️</span>
            : err[iso]
              ? <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.02em", color: "var(--muted-fg)", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: 3, padding: "1px 3px", lineHeight: 1.3 }}>{iso}</span>
              : <img className="flag" src={`https://flagcdn.com/w40/${iso.toLowerCase()}.png`} srcSet={`https://flagcdn.com/w80/${iso.toLowerCase()}.png 2x`} alt={iso} loading="lazy" onError={() => setErr(e => ({ ...e, [iso]: true }))} />}
        </span>
      ))}
    </span>
  );
}
// ─── Traduzione automatica note (MyMemory, gratuita, no API key) ───────────────
async function translateText(text, source, target) {
  if (!text || !text.trim() || source === target) return text || "";
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`);
    const data = await res.json();
    return data?.responseData?.translatedText || text;
  } catch {
    return text;
  }
}

// ─── Cloudinary: miniatura on-the-fly (riduce molto i byte scaricati) ───────────
function cldThumb(url, w = 400) {
  if (!url || typeof url !== "string" || !url.includes("/upload/")) return url;
  // evita doppie trasformazioni
  if (/\/upload\/(?:[a-z]{1,3}_[^/]+)\//.test(url)) return url;
  return url.replace("/upload/", `/upload/w_${w},c_limit,q_auto,f_auto/`);
}

// ─── Valore stimato helpers ─────────────────────────────────────────────────────
function parseValore(v) {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(",", ".").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}
function fmtValore(v, lang = "it") {
  const n = parseValore(v);
  if (!n) return "—";
  const locale = lang === "en" ? "en-US" : "it-IT";
  return "€ " + n.toLocaleString(locale, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
const ToastCtx = { listeners: [] };
const toast = {
  success: m => ToastCtx.listeners.forEach(f => f({ type: "success", msg: m })),
  error: m => ToastCtx.listeners.forEach(f => f({ type: "error", msg: m })),
  info: m => ToastCtx.listeners.forEach(f => f({ type: "info", msg: m })),
};
function Toaster() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const h = t => { const id = Date.now(); setToasts(p => [...p, { ...t, id }]); setTimeout(() => setToasts(p => p.filter(x => x.id !== id)), 3000); };
    ToastCtx.listeners.push(h);
    return () => { ToastCtx.listeners = ToastCtx.listeners.filter(f => f !== h); };
  }, []);
  return (
    <div style={{ position: "fixed", bottom: 80, right: 16, zIndex: 9998, display: "flex", flexDirection: "column", gap: 8 }}>
      {toasts.map(t => (
        <div key={t.id} style={{ background: t.type === "success" ? "#0a2a0a" : t.type === "info" ? "#0a1a2a" : "#2a0a0a", border: `1px solid ${t.type === "success" ? "#00ff41" : t.type === "info" ? "#00aaff" : "#ff3333"}`, color: t.type === "success" ? "#00ff41" : t.type === "info" ? "#00aaff" : "#ff3333", padding: "8px 16px", ...mono, fontSize: 11, letterSpacing: "0.1em", maxWidth: 300 }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function Spinner({ size = 24 }) {
  return <div className="spin" style={{ width: size, height: size, border: "2px solid var(--primary)", borderTopColor: "transparent", borderRadius: "50%", flexShrink: 0 }} />;
}

function Btn({ children, onClick, variant = "ghost", style = {}, disabled, ...p }) {
  const base = { ...mono, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", padding: "6px 12px", border: "1px solid", display: "inline-flex", alignItems: "center", gap: 6, transition: "all 0.15s", background: "transparent", minHeight: 32, opacity: disabled ? 0.5 : 1 };
  const variants = { primary: { borderColor: "var(--primary)", color: "var(--primary)", background: "var(--primary-dim)" }, ghost: { borderColor: "var(--border)", color: "var(--muted-fg)" }, danger: { borderColor: "#3a1a1a", color: "var(--destructive)" } };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }} {...p}>{children}</button>;
}

function MetaTag({ children }) {
  return <span style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", background: "var(--muted)", border: "1px solid var(--border)", padding: "2px 6px", whiteSpace: "nowrap" }}>{children}</span>;
}


// ─── Header ───────────────────────────────────────────────────────────────────
const NAV = [
  { id: "vault", labelKey: "nav_vault", Icon: Database },
  { id: "mappa", labelKey: "nav_map", Icon: MapIcon },
  { id: "stats", labelKey: "nav_stats", Icon: BarChart2 },
  { id: "doppioni", labelKey: "nav_duplicates", Icon: Copy },
  { id: "wishlist", labelKey: "nav_wishlist", Icon: Heart },
];

function ThemeToggle({ className = "" }) {
  const { t } = useLang();
  const [theme, setTheme] = useState(() => localStorage.getItem("vault_theme") || "dark");
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("vault_theme", theme); }, [theme]);
  return (
    <button className={className} title={t("theme_title")} onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
      style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: 8 }}>
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function AppHeader({ page, setPage, totalCount, totalValue, onAdd, onExport, onImport, user, onLogout, admin, onToggleAdmin, loginBusy, onShowRules, onSetPassword, onMigratePrices, migratingPrices, onUppercaseData, uppercasingData }) {
  const { t, lang } = useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const hasActions = onImport || onExport || onAdd;
  return (
    <>
      <header className="hdr-bar" style={{ background: "var(--secondary)", borderBottom: "1px solid var(--border)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0, zIndex: 50 }}>
        <div className="hdr-row1" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div className="hdr-title" style={{ ...orbitron, fontSize: 16, color: "var(--fg-strong)", letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 8 }}><img className="hdr-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="Monster Vault" style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0 }} /> MONSTER VAULT</div>
          {totalCount != null && <div style={{ ...mono, fontSize: 11, color: "var(--fg-strong)" }}>{totalCount} {t("header_lattine")}</div>}
          {totalValue != null && <div title={t("kpi_valore")} style={{ ...mono, fontSize: 11, fontWeight: 700, color: "var(--primary)", background: "var(--primary-dim)", border: "1px solid var(--primary-border)", borderRadius: 6, padding: "2px 9px", letterSpacing: "0.05em" }}>{totalValue > 0 ? fmtValore(totalValue, lang) : "€ 0"}</div>}
          <nav className="desktop-nav-inline" style={{ display: "flex", gap: 4 }}>
            {NAV.map(n => (
              <button key={n.id} onClick={() => setPage(n.id)} style={{ ...mono, fontSize: 11, padding: "5px 12px", border: "1px solid", letterSpacing: "0.1em", textTransform: "uppercase", transition: "all 0.15s", background: "transparent", ...(page === n.id ? { borderColor: "var(--primary)", color: "var(--primary)", background: "var(--primary-dim)" } : { borderColor: "transparent", color: "var(--fg-strong)" }) }}>
                {t(n.labelKey)}
              </button>
            ))}
          </nav>
          {/* Aiuto → tema → lingua → admin/account: sempre in quest'ordine, sempre ancorati
              all'estrema destra della riga, sulla stessa linea del titolo anche su telefono
              (le icone si rimpiccioliscono un po' sotto i 640px per starci). */}
          <div className="hdr-icons" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
            {onShowRules && <button className="hdr-icon-btn" title={t("header_help")} onClick={onShowRules} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: 8, flexShrink: 0 }}><HelpCircle size={15} /></button>}
            <ThemeToggle className="hdr-icon-btn" />
            <LangToggle className="hdr-lang-btn" />
            {onToggleAdmin && <Btn className="hdr-lock-btn" onClick={onToggleAdmin} disabled={loginBusy} variant={admin ? "primary" : "ghost"}>{loginBusy ? <Spinner size={12} /> : admin ? <Unlock size={12} /> : <Lock size={12} />}<span className="hdr-lockLabel">{admin ? t("header_admin") : t("header_guest")}</span></Btn>}
            {user && (
              <div style={{ position: "relative" }}>
                <button className="hdr-icon-btn" onClick={() => setMenuOpen(v => !v)} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: "50%", overflow: "hidden" }}>
                  {user?.photoURL ? <img src={user.photoURL} style={{ width: 32, height: 32, objectFit: "cover" }} /> : <User size={14} />}
                </button>
                {menuOpen && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                    <div style={{ position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 50, background: "var(--card)", border: "1px solid var(--border)", minWidth: 180 }}>
                      <div style={{ padding: "10px 12px", ...mono, fontSize: 10, color: "var(--muted-fg)", borderBottom: "1px solid var(--border)" }}>{user.email}</div>
                      {admin && onSetPassword && (
                        <button onClick={() => { onSetPassword(); setMenuOpen(false); }} style={{ width: "100%", textAlign: "left", padding: "10px 12px", ...mono, fontSize: 11, color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                          <Lock size={12} /> {t("header_set_password")}
                        </button>
                      )}
                      {admin && onMigratePrices && (
                        <button onClick={() => { onMigratePrices(); setMenuOpen(false); }} disabled={migratingPrices} style={{ width: "100%", textAlign: "left", padding: "10px 12px", ...mono, fontSize: 11, color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.1em", textTransform: "uppercase", opacity: migratingPrices ? 0.5 : 1 }}>
                          {migratingPrices ? <Spinner size={12} /> : <Lock size={12} />} {t("header_migrate_prices")}
                        </button>
                      )}
                      {admin && onUppercaseData && (
                        <button onClick={() => { onUppercaseData(); setMenuOpen(false); }} disabled={uppercasingData} style={{ width: "100%", textAlign: "left", padding: "10px 12px", ...mono, fontSize: 11, color: "var(--fg)", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.1em", textTransform: "uppercase", opacity: uppercasingData ? 0.5 : 1 }}>
                          {uppercasingData ? <Spinner size={12} /> : <Type size={12} />} {t("header_uppercase_data")}
                        </button>
                      )}
                      <button onClick={() => { onLogout(); setMenuOpen(false); }} style={{ width: "100%", textAlign: "left", padding: "10px 12px", ...mono, fontSize: 11, color: "var(--destructive)", background: "transparent", border: "none", display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        <LogOut size={12} /> {t("header_esci")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {hasActions && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onImport && <Btn onClick={onImport}><Upload size={12} /><span>{t("header_import")}</span></Btn>}
            {onExport && <Btn onClick={onExport}><Download size={12} /><span>{t("header_export")}</span></Btn>}
            {onAdd && <Btn onClick={onAdd} variant="primary"><Plus size={12} /><span>{t("header_add")}</span></Btn>}
          </div>
        )}
      </header>
      <nav style={{ display: "none", position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, background: "var(--secondary)", borderTop: "1px solid var(--primary-border)" }} className="mobile-nav">
        {NAV.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, padding: "10px 0", background: "transparent", border: "none", color: page === n.id ? "var(--primary)" : "var(--muted-fg)", minHeight: 60 }}>
            <n.Icon size={26} />
            <span style={{ ...mono, fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase" }}>{t(n.labelKey)}</span>
          </button>
        ))}
      </nav>
      <style>{`@media(max-width:640px){
        .mobile-nav{display:flex!important;}
        .desktop-nav-inline{display:none!important;}
        .hdr-lockLabel{display:none;}
        .hdr-bar{padding:10px 10px!important;}
        .hdr-row1{flex-wrap:nowrap!important; gap:6px!important;}
        .hdr-title{font-size:13px!important; gap:6px!important; white-space:nowrap; overflow:hidden;}
        .hdr-logo{width:26px!important; height:26px!important;}
        .hdr-icons{gap:5px!important; flex-wrap:nowrap!important;}
        .hdr-icon-btn{width:27px!important; height:27px!important; flex-shrink:0;}
        .hdr-lock-btn{padding:5px 7px!important; min-height:27px!important; flex-shrink:0;}
        .hdr-lang-btn{height:27px!important; padding:0 6px!important; font-size:8px!important; gap:3px!important; flex-shrink:0;}
        .hdr-lang-flag{width:13px!important; height:10px!important;}
      }`}</style>
    </>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────
function StatsBar({ cans }) {
  const stats = [
    { num: cans.length, label: "TOTALE" },
    { num: new Set(cans.map(c => c.tipo_linea).filter(Boolean)).size, label: "LINEE" },
    { num: cans.filter(c => c.photos?.some(p => p)).length, label: "CON FOTO" },
    { num: cans.filter(c => c.piena_vuota === "FULL").length, label: "PIENE" },
    { num: cans.filter(c => c.piena_vuota === "EMPTY").length, label: "VUOTE" },
  ];
  return (
    <div style={{ display: "flex", gap: 16, padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "var(--secondary)", flexWrap: "wrap" }}>
      {stats.map(s => <div key={s.label} style={{ ...mono, fontSize: 11, color: "var(--fg-strong)" }}><span style={{ color: "var(--primary)", fontWeight: 700, marginRight: 4 }}>{s.num}</span>{s.label}</div>)}
    </div>
  );
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function getSortOptions(t, showValue = true) {
  return [
    { value: "default", label: t("sort_default") },
    { value: "name_az", label: t("sort_name_az") },
    { value: "name_za", label: t("sort_name_za") },
    { value: "sku_asc", label: t("sort_sku_asc") },
    { value: "sku_desc", label: t("sort_sku_desc") },
    { value: "tipo", label: t("sort_tipo") },
    { value: "recent", label: t("sort_recent") },
    ...(showValue ? [
      { value: "valore_desc", label: t("sort_valore_desc") },
      { value: "valore_asc", label: t("sort_valore_asc") },
    ] : []),
  ];
}

function FilterSelect({ value, onChange, placeholder, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...mono, fontSize: 11, background: "var(--muted)", border: "1px solid var(--border)", color: value ? "var(--primary)" : "var(--muted-fg)", padding: "5px 8px", letterSpacing: "0.08em", width: "100%", minWidth: 0 }}>
      <option value="">{placeholder}</option>
      {options.map(opt => <option key={typeof opt === "object" ? opt.value : opt} value={typeof opt === "object" ? opt.value : opt}>{typeof opt === "object" ? opt.label : opt}</option>)}
    </select>
  );
}

function ViewsMenu({ filters, setFilters, chipStyle }) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState(loadViews);
  const apply = v => { setFilters({ ...DEFAULT_FILTERS, ...v.filters }); setOpen(false); };
  const save = () => { const name = window.prompt("Nome della vista:"); if (!name) return; const next = [...views.filter(x => x.name !== name), { name, filters }]; setViews(next); persistViews(next); toast.success("Vista salvata ✓"); setOpen(false); };
  const del = (e, name) => { e.stopPropagation(); const next = views.filter(x => x.name !== name); setViews(next); persistViews(next); };
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} style={chipStyle(open)}>★ VISTE{views.length ? ` (${views.length})` : ""}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 50, background: "var(--card)", border: "1px solid var(--border)", minWidth: 210, maxHeight: 300, overflow: "auto" }}>
            <button onClick={save} style={{ width: "100%", textAlign: "left", padding: "9px 12px", ...mono, fontSize: 11, color: "var(--primary)", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", letterSpacing: "0.1em", cursor: "pointer" }}>+ SALVA VISTA ATTUALE</button>
            {views.length === 0 && <div style={{ padding: "9px 12px", ...mono, fontSize: 10, color: "var(--muted-fg)" }}>Nessuna vista salvata</div>}
            {views.map(v => (
              <div key={v.name} onClick={() => apply(v)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid #151515" }}>
                <span style={{ ...mono, fontSize: 11, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</span>
                <button onClick={e => del(e, v.name)} style={{ border: "none", background: "transparent", color: "var(--destructive)", cursor: "pointer", fontSize: 12 }}>✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FiltersBar({ cans, filters, setFilters, filteredCount, view, setView, showValue = true }) {
  const { t, lang } = useLang();
  // Ogni tendina/chip mostra solo le opzioni compatibili con TUTTI GLI ALTRI
  // filtri già attivi (escluso se stessa), così i filtri restano coerenti tra
  // loro invece di elencare sempre tutta la collezione.
  const tipos = [...new Set(filterCansExcept(cans, filters, ["tipo"]).map(c => c.tipo_linea).filter(Boolean))].sort();
  const sizes = [...new Set(filterCansExcept(cans, filters, ["size"]).map(c => c.size).filter(Boolean))].sort((a, b) => parseFloat(a) - parseFloat(b));
  const prods = [...new Set(filterCansExcept(cans, filters, ["produttore"]).map(c => c.produttore).filter(Boolean))].sort();
  const aperture = [...new Set(filterCansExcept(cans, filters, ["apertura"]).map(c => c.apertura).filter(Boolean))].sort();
  const nazioni = [...new Set(filterCansExcept(cans, filters, ["nazione"]).map(c => c.lingua).filter(Boolean))].map(v => ({ value: v, label: countryName(v, lang) })).sort((a, b) => a.label.localeCompare(b.label));
  const cPhoto = filterCansExcept(cans, filters, ["photoOnly", "noPhoto"]).filter(c => c.photos?.some(p => p)).length;
  const cNoPhoto = filterCansExcept(cans, filters, ["photoOnly", "noPhoto"]).filter(c => !c.photos?.some(p => p)).length;
  const cFull = filterCansExcept(cans, filters, ["piena_vuota"]).filter(c => c.piena_vuota === "FULL").length;
  const cEmpty = filterCansExcept(cans, filters, ["piena_vuota"]).filter(c => c.piena_vuota === "EMPTY").length;
  const cValued = filterCansExcept(cans, filters, ["valuedOnly", "noValue"]).filter(c => parseValore(c.valore) > 0).length;
  const cNoValue = filterCansExcept(cans, filters, ["valuedOnly", "noValue"]).filter(c => !(parseValore(c.valore) > 0)).length;
  const chipStyle = (active, col = "var(--primary)") => ({ ...mono, fontSize: 11, border: "1px solid", padding: "5px 10px", letterSpacing: "0.08em", background: active ? "var(--primary-dim)" : "transparent", borderColor: active ? col : "var(--border)", color: active ? col : "var(--muted-fg)", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" });
  const cnt = n => <span style={{ fontWeight: 700, opacity: 0.85 }}>{n}</span>;
  const update = (key, val) => setFilters(p => ({ ...p, [key]: val }));
  const reset = () => setFilters({ search: "", tipo: "", size: "", produttore: "", piena_vuota: "", apertura: "", sort: "default", photoOnly: false, noPhoto: false, valuedOnly: false, noValue: false, nazione: "" });
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 16px", background: "var(--secondary)", display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="filters-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, alignItems: "center" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", minWidth: 0 }}>
          <Search size={12} style={{ position: "absolute", left: 8, color: "var(--muted-fg)" }} />
          <input type="text" placeholder={t("search_ph")} value={filters.search} onChange={e => update("search", e.target.value)} style={{ ...mono, fontSize: 11, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "6px 8px 6px 24px", width: "100%" }} />
        </div>
        <FilterSelect value={filters.tipo} onChange={v => update("tipo", v)} placeholder={t("filter_all_lines")} options={tipos} />
        <FilterSelect value={filters.size} onChange={v => update("size", v)} placeholder={t("filter_all_sizes")} options={sizes} />
        <FilterSelect value={filters.produttore} onChange={v => update("produttore", v)} placeholder={t("filter_producers")} options={prods} />
        <FilterSelect value={filters.nazione} onChange={v => update("nazione", v)} placeholder={t("filter_nation")} options={nazioni} />
      </div>
      <div className="chips-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${showValue ? 6 : 4}, 1fr)`, gap: 8 }}>
        <button onClick={() => update("piena_vuota", filters.piena_vuota === "FULL" ? "" : "FULL")} style={{ ...chipStyle(filters.piena_vuota === "FULL", "#ffbf00"), width: "100%", justifyContent: "center" }}>{t("chip_full")} {cnt(cFull)}</button>
        <button onClick={() => update("piena_vuota", filters.piena_vuota === "EMPTY" ? "" : "EMPTY")} style={{ ...chipStyle(filters.piena_vuota === "EMPTY", "#4ade80"), width: "100%", justifyContent: "center" }}>{t("chip_empty")} {cnt(cEmpty)}</button>
        <button onClick={() => update("photoOnly", !filters.photoOnly)} style={{ ...chipStyle(filters.photoOnly), width: "100%", justifyContent: "center" }}>{t("chip_photo")} {cnt(cPhoto)}</button>
        <button onClick={() => update("noPhoto", !filters.noPhoto)} style={{ ...chipStyle(filters.noPhoto, "var(--destructive)"), width: "100%", justifyContent: "center" }}>{t("chip_no_photo")} {cnt(cNoPhoto)}</button>
        {showValue && <button onClick={() => update("valuedOnly", !filters.valuedOnly)} style={{ ...chipStyle(filters.valuedOnly), width: "100%", justifyContent: "center" }}>{t("chip_value")} {cnt(cValued)}</button>}
        {showValue && <button onClick={() => update("noValue", !filters.noValue)} style={{ ...chipStyle(filters.noValue, "var(--destructive)"), width: "100%", justifyContent: "center" }}>{t("chip_no_value")} {cnt(cNoValue)}</button>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <FilterSelect value={filters.sort} onChange={v => update("sort", v)} placeholder={t("sort_ph")} options={getSortOptions(t, showValue)} />
        <button onClick={reset} style={{ ...mono, fontSize: 11, border: "1px solid transparent", color: "var(--destructive)", padding: "5px 10px", background: "transparent", display: "flex", alignItems: "center", gap: 4 }}><X size={12} /> {t("reset")}</button>
        <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", marginLeft: "auto", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 12 }}>
          {t("of_total", filteredCount, cans.length)}
          {setView && <ViewToggle view={view} setView={setView} />}
        </div>
      </div>
    </div>
  );
}

// ─── Can Card ─────────────────────────────────────────────────────────────────
function LazyImage({ src, alt }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { rootMargin: "200px" });
    obs.observe(el); return () => obs.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width: "100%", height: "100%", position: "relative" }}>
      {!loaded && <div className={visible ? "skeleton" : ""} style={{ position: "absolute", inset: 0, background: visible ? undefined : "var(--card)" }} />}
      {visible && <img src={src} alt={alt} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0, transition: "opacity 0.4s ease" }} />}
    </div>
  );
}

function CanCard({ can, onClick, showValue = true }) {
  const { t, lang } = useLang();
  const firstPhoto = can.photos?.find(p => p) || "";
  const accent = lineColor(can.tipo_linea);
  const valore = showValue ? parseValore(can.valore) : 0;
  return (
    <div className="can-card" onClick={onClick} style={{ background: "var(--card)", cursor: "pointer", overflow: "hidden", "--card-accent": accent }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.85, zIndex: 1 }} />
      <div style={{ width: "100%", paddingTop: "100%", position: "relative", overflow: "hidden", background: "var(--bg)" }}>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {firstPhoto ? <LazyImage src={cldThumb(firstPhoto)} alt={can.nome} /> : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, var(--card), var(--muted))" }}>
              <span style={{ ...orbitron, fontSize: 48, color: accent, opacity: 0.18 }}>M</span>
            </div>
          )}
        </div>
        {can.tipo_linea && <span style={{ position: "absolute", top: 6, left: 6, ...mono, fontSize: 9, background: "rgba(0,0,0,0.85)", border: `1px solid ${accent}66`, color: accent, padding: "2px 6px", letterSpacing: "0.1em" }}>{can.tipo_linea}</span>}
        {can.piena_vuota && <span style={{ position: "absolute", top: 6, right: 6, ...mono, fontSize: 9, background: "rgba(0,0,0,0.85)", border: `1px solid ${can.piena_vuota === "FULL" ? "#ffbf00" : "#333"}`, color: can.piena_vuota === "FULL" ? "#ffbf00" : "#555", padding: "2px 6px", letterSpacing: "0.1em" }}>{can.piena_vuota === "FULL" ? t("pv_full") : can.piena_vuota === "EMPTY" ? t("pv_empty") : can.piena_vuota}</span>}
        {valore > 0 && <span style={{ position: "absolute", bottom: 6, right: 6, ...mono, fontSize: 10, fontWeight: 700, background: "rgba(0,0,0,0.85)", border: "1px solid rgba(34,197,94,0.5)", color: "#4ade80", padding: "2px 7px", letterSpacing: "0.05em" }}>{fmtValore(valore, lang)}</span>}
      </div>
      <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{can.nome || "—"}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
          {can.sku && <span style={{ ...mono, fontSize: 10, color: "var(--primary)" }}>{can.sku}</span>}
          {can.sku && can.produttore && <span style={{ ...mono, fontSize: 10, color: "#333" }}>·</span>}
          {can.produttore && <span style={{ ...mono, fontSize: 10, color: "var(--muted-fg)" }}>{can.produttore}</span>}
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
          {can.size && <MetaTag>{can.size}</MetaTag>}
          {can.lingua && <MetaTag><Flag lingua={can.lingua} />{countryName(can.lingua, lang)}</MetaTag>}
        </div>
        <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 6, height: 6, border: `1px solid ${can.photos?.[i] ? "var(--primary)" : "var(--border)"}`, background: can.photos?.[i] ? "var(--primary)" : "transparent" }} />)}
        </div>
      </div>
    </div>
  );
}

// ─── Can List Row (vista elenco) ───────────────────────────────────────────────
function CanListRow({ can, onClick }) {
  const { t, lang } = useLang();
  const firstPhoto = can.photos?.find(p => p) || "";
  return (
    <div className="can-list-row" onClick={onClick} style={{ display: "grid", gridTemplateColumns: "48px 1.6fr 0.9fr 1fr 1.2fr 0.7fr 1fr 0.8fr", gap: 12, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
      <div style={{ width: 40, height: 40, borderRadius: 4, overflow: "hidden", background: "var(--bg)", flexShrink: 0 }}>
        {firstPhoto ? <img src={cldThumb(firstPhoto, 80)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ ...orbitron, fontSize: 16, color: "var(--border)" }}>M</span></div>
        )}
      </div>
      <div style={{ fontWeight: 600, fontSize: 12, color: "var(--fg)", textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{can.nome || "—"}</div>
      <div style={{ ...mono, fontSize: 11, color: "var(--primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{can.sku || "—"}</div>
      <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{can.produttore || "—"}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {can.lingua ? <><Flag lingua={can.lingua} /><span style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{countryName(can.lingua, lang)}</span></> : <span style={{ ...mono, fontSize: 11, color: "var(--muted-fg)" }}>—</span>}
      </div>
      <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", whiteSpace: "nowrap" }}>{can.size || "—"}</div>
      <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{can.top_tab || "—"}</div>
      <div>
        {can.piena_vuota && <span style={{ ...mono, fontSize: 9, display: "inline-block", background: "rgba(0,0,0,0.3)", border: `1px solid ${can.piena_vuota === "FULL" ? "#ffbf00" : "#4ade80"}`, color: can.piena_vuota === "FULL" ? "#ffbf00" : "#4ade80", padding: "2px 7px", letterSpacing: "0.08em", borderRadius: 3 }}>{can.piena_vuota === "FULL" ? t("pv_full") : can.piena_vuota === "EMPTY" ? t("pv_empty") : can.piena_vuota}</span>}
      </div>
    </div>
  );
}

// ─── View Toggle (griglia / elenco) ────────────────────────────────────────────
function useVaultView() {
  const [view, setView] = useState(() => localStorage.getItem("vault_view") || "grid");
  useEffect(() => { localStorage.setItem("vault_view", view); }, [view]);
  return [view, setView];
}
function ViewToggle({ view, setView }) {
  const { t } = useLang();
  return (
    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
      <button title={t("view_grid_title")} onClick={() => setView("grid")} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid", borderColor: view === "grid" ? "var(--primary)" : "var(--border)", color: view === "grid" ? "var(--primary)" : "var(--muted-fg)", background: view === "grid" ? "var(--primary-dim)" : "transparent" }}><LayoutGrid size={14} /></button>
      <button title={t("view_list_title")} onClick={() => setView("list")} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid", borderColor: view === "list" ? "var(--primary)" : "var(--border)", color: view === "list" ? "var(--primary)" : "var(--muted-fg)", background: view === "list" ? "var(--primary-dim)" : "transparent" }}><List size={14} /></button>
    </div>
  );
}

// ─── Can Grid ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 60;
function CanGrid({ cans, onSelect, emptyLabel, view, showValue = true }) {
  const { t } = useLang();
  const [count, setCount] = useState(PAGE_SIZE);

  if (!cans.length) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 20px" }}>
      <div style={{ ...orbitron, fontSize: 64, color: "var(--border)", marginBottom: 16 }}>M</div>
      <div style={{ ...mono, color: "var(--muted-fg)" }}>{emptyLabel || t("empty_state")}</div>
    </div>
  );

  return (
    <div style={{ padding: "16px" }}>
      {view === "list" ? (
        <div className="can-list no-scrollbar" style={{ border: "1px solid var(--border)", overflowX: "auto" }}>
          <div className="can-list-header" style={{ display: "grid", gridTemplateColumns: "48px 1.6fr 0.9fr 1fr 1.2fr 0.7fr 1fr 0.8fr", gap: 12, padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--secondary)", minWidth: 720 }}>
            {["", "col_name", "col_sku", "col_manufacturer", "col_country", "col_size", "col_toptab", "col_status"].map((k, i) => (
              <div key={i} style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{k ? t(k) : ""}</div>
            ))}
          </div>
          <div style={{ minWidth: 720 }}>
            {cans.slice(0, count).map(can => <CanListRow key={can.id} can={can} onClick={() => onSelect(can)} />)}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 14, background: "transparent" }}>
          {cans.slice(0, count).map(can => <CanCard key={can.id} can={can} onClick={() => onSelect(can)} showValue={showValue} />)}
        </div>
      )}
      {cans.length > count && (
        <div style={{ display: "flex", justifyContent: "center", padding: "24px 0" }}>
          <Btn onClick={() => setCount(p => p + PAGE_SIZE)} variant="primary" style={{ padding: "10px 32px", fontSize: 12, letterSpacing: "0.15em" }}>{t("load_more")}</Btn>
        </div>
      )}
    </div>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function DetailModal({ can, open, onClose, onEdit, onDelete, onPrev, onNext, showValue = true }) {
  const { t, lang } = useLang();
  const [activePhoto, setActivePhoto] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef(null);
  useEffect(() => { setActivePhoto(0); setConfirmDelete(false); }, [can?.id]);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);
  const handleDeleteClick = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      confirmTimer.current = setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmDelete(false);
    onDelete();
  };
  useEffect(() => {
    if (!open) return;
    const h = e => { if (e.key === "ArrowLeft") onPrev?.(); if (e.key === "ArrowRight") onNext?.(); if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [open, onPrev, onNext, onClose]);
  if (!can || !open) return null;
  const photos = can.photos?.length === 4 ? can.photos : ["", "", "", ""];
  const currentPhoto = photos[activePhoto] || photos.find(p => p) || "";
  const fields = [
    ["field_tipo_linea", can.tipo_linea], ["field_nome", can.nome], ["field_sku", can.sku], ["field_produttore", can.produttore], ["field_size", can.size],
    ["field_lingua", can.lingua ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Flag lingua={can.lingua} />{countryName(can.lingua, lang)}</span> : ""],
    ["field_top_tab", can.top_tab],
    ["field_pv", can.piena_vuota === "FULL" ? t("pv_full") : can.piena_vuota === "EMPTY" ? t("pv_empty") : can.piena_vuota],
    ["field_apertura", can.apertura],
    ...(showValue ? [["field_valore", fmtValore(can.valore, lang)]] : []),
    ["field_condizione", can.condizione ? `${can.condizione}/10` : ""],
    ["field_note", (lang === "it" ? can.note_it : can.note_en) ?? can.note ?? ""],
  ];
  return (
    <div className="fade-in" style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="modal-in" style={{ background: "var(--secondary)", border: "1px solid var(--border)", borderRadius: 14, width: "100%", maxWidth: 860, height: "min(94vh, 720px)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "var(--shadow)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--primary-border)", flexShrink: 0 }}>
          <Btn onClick={onPrev} style={{ padding: "4px 10px", fontSize: 11 }}><ChevronLeft size={12} /><span className="btn-label">{t("detail_prev")}</span></Btn>
          <div style={{ flex: 1, ...orbitron, fontSize: 13, color: "var(--primary)", textTransform: "uppercase", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{can.nome || t("detail_can_fallback")}</div>
          <Btn onClick={onNext} style={{ padding: "4px 10px", fontSize: 11 }}><span className="btn-label">{t("detail_next")}</span><ChevronRight size={12} /></Btn>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><X size={14} /></button>
        </div>
        <div className="no-scrollbar" style={{ overflow: "auto", flex: 1 }}>
          <div className="detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: 16, height: "100%" }}>
            <div className="detail-photo-col" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div className="detail-photo-box" style={{ width: "100%", flex: 1, minHeight: 220, position: "relative", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 8, overflow: "hidden" }}>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {currentPhoto ? <img src={cldThumb(currentPhoto, 900)} alt={can.nome} decoding="async" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ ...orbitron, fontSize: 64, color: "var(--border)" }}>M</span>}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, flexShrink: 0 }}>
                {photos.map((p, i) => (
                  <div key={i} onClick={() => p && setActivePhoto(i)} style={{ paddingTop: "100%", position: "relative", background: "var(--muted)", border: `1px solid ${i === activePhoto && p ? "var(--primary)" : "var(--border)"}`, cursor: p ? "pointer" : "default", overflow: "hidden" }}>
                    <div style={{ position: "absolute", inset: 0 }}>
                      {p ? <img src={cldThumb(p, 160)} alt="" loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ position: "absolute", bottom: 2, right: 4, ...mono, fontSize: 9, color: "var(--border)" }}>+</span>}
                    </div>
                    <span style={{ position: "absolute", bottom: 2, right: 4, ...mono, fontSize: 9, color: "var(--muted-fg)" }}>{i + 1}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {fields.map(([key, val]) => (
                <div key={key} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 6 }}>
                  <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 2 }}>{t(key)}</div>
                  <div style={{ fontSize: key === "field_note" ? 13 : 15, fontWeight: key === "field_note" ? 400 : 600, lineHeight: key === "field_note" ? 1.5 : undefined, whiteSpace: key === "field_note" ? "pre-wrap" : undefined, color: (key === "field_tipo_linea" || key === "field_sku" || key === "field_valore") ? "var(--primary)" : "var(--fg-strong)" }}>{val || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        {(onEdit || onDelete) && (
          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, justifyContent: "flex-end", flexShrink: 0, background: "var(--secondary)" }}>
            {onEdit && <Btn onClick={onEdit}><Pencil size={12} />{t("modifica")}</Btn>}
            {onDelete && <Btn onClick={handleDeleteClick} variant="danger" style={confirmDelete ? { background: "var(--destructive)", color: "#fff", borderColor: "var(--destructive)" } : undefined}>
              <Trash2 size={12} />{confirmDelete ? t("confirm_delete") : t("elimina")}
            </Btn>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
const APERTURA_OPTIONS = ["", "TOP", "BOTTOM", "TOP AND BOTTOM", "NO", "TAPPO", "BARCODE", "?"];
const PV_OPTIONS = ["", "FULL", "EMPTY", "?"];

function PhotoPreviewModal({ file, onConfirm, onCancel }) {
  const { t } = useLang();
  const [previewUrl, setPreviewUrl] = useState(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!file) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.95)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 12 }}>{t("preview_title")}</div>
      {/* Simulazione card */}
      <div style={{ width: 220, background: "var(--card)", border: "1px solid var(--border)" }}>
        <div style={{ width: "100%", paddingTop: "100%", position: "relative", overflow: "hidden", background: "var(--bg)" }}>
          <div style={{ position: "absolute", inset: 0 }}>
            {previewUrl && <img src={previewUrl} alt="preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
          {/* Guide overlay */}
          <div style={{ position: "absolute", inset: 0, border: "2px solid rgba(0,255,65,0.6)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 2, height: "100%", background: "rgba(0,255,65,0.15)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: "100%", height: 2, background: "rgba(0,255,65,0.15)", pointerEvents: "none" }} />
        </div>
        <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border)" }}>
          <div style={{ ...mono, fontSize: 9, color: "var(--muted-fg)" }}>{t("preview_shown_as")}</div>
        </div>
      </div>
      <div style={{ ...mono, fontSize: 10, color: "#444", marginTop: 12, marginBottom: 20, textAlign: "center", lineHeight: 1.6 }}>
        {t("preview_crop_note")}<br />{t("preview_center")}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <Btn onClick={onCancel} variant="danger"><X size={12} /> {t("preview_retry")}</Btn>
        <Btn onClick={() => onConfirm(file)} variant="primary">{t("preview_use")}</Btn>
      </div>
    </div>
  );
}

function EditModal({ can, open, onClose, onSave, allCans }) {
  const { t, lang } = useLang();
  const optLabel = (key, opt) => {
    if (key === "piena_vuota") return opt === "FULL" ? t("pv_full") : opt === "EMPTY" ? t("pv_empty") : opt;
    if (key === "apertura" && opt === "TAPPO") return lang === "it" ? "TAPPO" : "CAP";
    return opt;
  };
  const [form, setForm] = useState({ tipo_linea: "", nome: "", sku: "", produttore: "", size: "", lingua: "", top_tab: "", piena_vuota: "", apertura: "", valore: "", condizione: "", note: "", photos: ["", "", "", ""] });
  const [uploading, setUploading] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState(null);
  const [saving, setSaving] = useState(false);
  const [subMenu, setSubMenu] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [previewSlot, setPreviewSlot] = useState(null);

  useEffect(() => {
    if (!open) return;
    setUploading(false);
    setSaving(false);
    if (can) {
      const noteForLang = can[`note_${lang}`] ?? can.note ?? "";
      setForm({ tipo_linea: can.tipo_linea || "", nome: can.nome || "", sku: can.sku || "", produttore: can.produttore || "", size: can.size || "", lingua: can.lingua || "", top_tab: can.top_tab || "", piena_vuota: can.piena_vuota || "", apertura: can.apertura || "", valore: can.valore != null ? String(can.valore) : "", condizione: can.condizione || "", note: noteForLang, photos: can.photos?.length === 4 ? [...can.photos] : ["", "", "", ""] });
    } else {
      setForm({ tipo_linea: "", nome: "", sku: "", produttore: "", size: "", lingua: "", top_tab: "", piena_vuota: "", apertura: "", valore: "", condizione: "", note: "", photos: ["", "", "", ""] });
    }
  }, [open, can, lang]);

  const update = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const handleFileChange = async (e, slot) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    setPreviewFile(file);
    setPreviewSlot(slot);
  };

  const handleConfirmPhoto = async (file) => {
    const slot = previewSlot;
    setPreviewFile(null);
    setPreviewSlot(null);
    setUploading(true); setUploadingSlot(slot);
    try {
      const url = await uploadToCloudinary(file);
      setForm(p => { const np = [...p.photos]; np[slot] = url; return { ...p, photos: np }; });
      toast.success(t("toast_photo_uploaded"));
    } catch (err) { toast.error(t("toast_upload_err", err.message)); }
    finally { setUploading(false); setUploadingSlot(null); }
  };

  const removePhoto = (i) => { const np = [...form.photos]; np[i] = ""; update("photos", np); };
  const handleSave = async () => {
    if (!form.tipo_linea.trim()) { toast.error(t("toast_tipo_required")); return; }
    const condizione = form.condizione === "" ? "" : Math.min(10, Math.max(1, Math.round(Number(form.condizione)) || 1));
    const { note, ...rest } = form;
    // Tutti i campi testuali della lattina si salvano sempre in maiuscolo,
    // anche se scritti a mano in minuscolo — così il sito mostra sempre dati
    // scritti in modo uniforme ovunque, senza doverci pensare ogni volta.
    const up = v => (v || "").trim().toUpperCase();
    const payload = { ...rest, tipo_linea: up(form.tipo_linea), nome: up(form.nome), sku: up(form.sku), produttore: up(form.produttore), size: up(form.size), lingua: up(form.lingua), top_tab: up(form.top_tab), valore: form.valore === "" ? "" : parseValore(form.valore), condizione };
    const otherLang = lang === "it" ? "en" : "it";
    const noteUpper = up(note);
    const noteChanged = note !== (can?.[`note_${lang}`] ?? can?.note ?? "");
    if (!noteUpper) {
      payload.note_it = ""; payload.note_en = "";
    } else if (noteChanged) {
      setSaving(true);
      payload[`note_${lang}`] = noteUpper;
      payload[`note_${otherLang}`] = up(await translateText(note, lang, otherLang));
      setSaving(false);
    } else {
      payload.note_it = up(can?.note_it ?? can?.note ?? "");
      payload.note_en = up(can?.note_en ?? "");
    }
    onSave(payload);
  };

  const tipos = [...new Set((allCans || []).map(c => c.tipo_linea).filter(Boolean))].sort();
  const prods = [...new Set((allCans || []).map(c => c.produttore).filter(Boolean))].sort();
  const sizes = [...new Set((allCans || []).map(c => c.size).filter(Boolean))].sort((a, b) => parseFloat(a) - parseFloat(b));

  if (!open) return null;
  return (
    <>
    {previewFile && <PhotoPreviewModal file={previewFile} onConfirm={handleConfirmPhoto} onCancel={() => { setPreviewFile(null); setPreviewSlot(null); }} />}
    <div className="fade-in" style={{ position: "fixed", inset: 0, zIndex: 110, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div className="sheet-in" style={{ background: "var(--secondary)", borderTop: "1px solid var(--primary-border)", width: "100%", maxWidth: 640, maxHeight: "95vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--primary-border)", flexShrink: 0 }}>
          <div style={{ flex: 1, ...orbitron, fontSize: 13, color: "var(--primary)", textTransform: "uppercase" }}>{can ? t("edit_title_edit") : t("edit_title_new")}</div>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><X size={14} /></button>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 16, paddingBottom: 32 }}>
          {/* Photos */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 8 }}>{t("edit_photos_label")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
              {form.photos.map((url, i) => (
                <div key={i} style={{ paddingTop: "100%", position: "relative", overflow: "hidden" }}>
                  {url ? (
                    <div style={{ position: "absolute", inset: 0 }}>
                      <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      <button onClick={() => removePhoto(i)} style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, background: "rgba(200,0,0,0.8)", color: "var(--fg-strong)", border: "none", fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>✕</button>
                    </div>
                  ) : (
                    <label style={{ position: "absolute", inset: 0, background: uploadingSlot === i ? "rgba(0,255,65,0.05)" : "var(--muted)", border: `1px dashed ${uploadingSlot === i ? "var(--primary)" : "var(--border)"}`, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
                      {uploadingSlot === i ? <Spinner size={16} /> : <Camera size={16} style={{ color: "var(--border)" }} />}
                      <span style={{ ...mono, fontSize: 9, color: "var(--muted-fg)" }}>{uploadingSlot === i ? "..." : t("edit_photo_n", i + 1)}</span>
                      <input type="file" accept="image/*" style={{ display: "none" }} onChange={e => handleFileChange(e, i)} disabled={uploading} />
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
          {/* Fields */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[{ key: "tipo_linea", label: t("edit_tipo_linea"), list: tipos }, { key: "nome", label: t("field_nome") }, { key: "sku", label: t("field_sku") }, { key: "produttore", label: t("field_produttore"), list: prods }, { key: "size", label: t("field_size"), list: sizes }, { key: "lingua", label: t("field_lingua") }, { key: "top_tab", label: t("field_top_tab") }, { key: "valore", label: t("edit_valore_eur") }].map(({ key, label, list }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</label>
                <input type="text" value={form[key]} onChange={e => update(key, e.target.value)} list={list ? `dl-${key}` : undefined}
                  style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "6px 8px", outline: "none", width: "100%" }}
                  onFocus={e => e.target.style.borderColor = "var(--primary)"} onBlur={e => e.target.style.borderColor = "var(--border)"} />
                {list && <datalist id={`dl-${key}`}>{list.map(v => <option key={v} value={v} />)}</datalist>}
              </div>
            ))}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{t("field_condizione")}</label>
              <div style={{ position: "relative" }}>
                <input type="number" min="1" max="10" step="1" value={form.condizione} onChange={e => update("condizione", e.target.value)} placeholder="1-10"
                  style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "6px 28px 6px 8px", outline: "none", width: "100%" }}
                  onFocus={e => e.target.style.borderColor = "var(--primary)"} onBlur={e => e.target.style.borderColor = "var(--border)"} />
                {form.condizione !== "" && <span style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", ...mono, fontSize: 12, color: "var(--muted-fg)", pointerEvents: "none" }}>/10</span>}
              </div>
            </div>
            {[{ key: "piena_vuota", label: t("field_pv"), options: PV_OPTIONS }, { key: "apertura", label: t("field_apertura"), options: APERTURA_OPTIONS }].map(({ key, label, options }) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</label>
                <div style={{ position: "relative" }}>
                  <button type="button" onClick={() => setSubMenu(subMenu === key ? null : key)} style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "6px 8px", width: "100%", textAlign: "left", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>{form[key] ? optLabel(key, form[key]) : "—"}</span><ChevronDown size={12} style={{ color: "var(--muted-fg)" }} />
                  </button>
                  {subMenu === key && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--card)", border: "1px solid var(--border)", zIndex: 120, maxHeight: 200, overflow: "auto" }}>
                      {options.map(opt => <button key={opt} onClick={() => { update(key, opt); setSubMenu(null); }} style={{ width: "100%", textAlign: "left", padding: "8px 12px", ...mono, fontSize: 12, background: form[key] === opt ? "var(--primary-dim)" : "transparent", color: form[key] === opt ? "var(--primary)" : "var(--fg)", border: "none" }}>{opt ? optLabel(key, opt) : t("edit_none")}</button>)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
            <label style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{t("field_note")}</label>
            <textarea value={form.note} onChange={e => update("note", e.target.value)} placeholder={t("edit_note_ph")} rows={3}
              style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "8px", outline: "none", width: "100%", resize: "vertical", fontFamily: "inherit" }}
              onFocus={e => e.target.style.borderColor = "var(--primary)"} onBlur={e => e.target.style.borderColor = "var(--border)"} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
            <Btn onClick={onClose}>{t("edit_cancel")}</Btn>
            <Btn onClick={handleSave} variant="primary" disabled={uploading || saving}>{saving ? t("edit_saving") : t("edit_save")}</Btn>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

// ─── Import Modal ─────────────────────────────────────────────────────────────
function ImportModal({ open, onClose, onImportDone, existingCans, isDuplicate }) {
  const { t } = useLang();
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef(null);

  const processFile = async (file) => {
    if (!file) return;
    setLoading(true); setStatus("Lettura file..."); setProgress(0);
    try {
      const XLSX = await loadXLSX();
      if (!XLSX) { setStatus("Errore: libreria XLSX non caricata"); setLoading(false); return; }
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      // Il foglio ha un TITOLO unito in riga 1 e righe-SEZIONE ("ULTRA (285)"), quindi l'header
      // automatico di sheet_to_json prende la riga sbagliata. Leggo come matrice grezza, trovo io la
      // riga intestazioni e mappo le colonne per nome (in qualsiasi ordine). Vedi monster-vault.
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
      const normHdr = s => String(s ?? "").trim().toUpperCase().replace(/\//g, "").replace(/\s+/g, "");
      const COLS = {
        tipo_linea: ["TIPOLINEA"], nome: ["NOME"], sku: ["SKU"], produttore: ["PRODUTTORE"],
        size: ["SIZE"], lingua: ["LINGUA", "LINGUAPAESE", "PAESE"], top_tab: ["TOPTAB"],
        piena_vuota: ["PIENAVUOTA"], apertura: ["APERTURA"],
        valore: ["VALORE", "VALORESTIMATO"],
      };
      const headerRow = aoa.findIndex(row => row.some(c => normHdr(c) === "TIPOLINEA"));
      if (headerRow === -1) { setStatus("Errore: intestazioni non trovate (serve una colonna TIPO LINEA)"); setLoading(false); return; }
      const colIdx = {};
      aoa[headerRow].forEach((cell, i) => {
        const h = normHdr(cell);
        for (const [field, names] of Object.entries(COLS)) if (names.includes(h) && colIdx[field] == null) colIdx[field] = i;
      });
      const at = (row, field) => colIdx[field] != null ? row[colIdx[field]] : "";
      setStatus("Verifico duplicati...");
      // Chiave duplicati: tutti i campi FISICI (no valore/rarità, che si modificano in-app), stessa
      // normalizzazione su archivio e file, così le varianti (size/lingua/…) non passano per duplicati.
      const norm = v => String(v ?? "").trim().toLowerCase();
      // SKU: nel sito gli SKU usano lo "0" (zero), nel foglio a volte la "O". Normalizzo O→0 così
      // "O815" e "0815" combaciano e non si creano doppioni. Vedi monster-vault.
      const normSku = v => norm(v).replace(/o/g, "0").replace(/\.0$/, "");
      const keyOf = o => [norm(o.tipo_linea), norm(o.nome), normSku(o.sku), norm(o.size), norm(o.lingua), norm(o.top_tab), norm(o.piena_vuota), norm(o.apertura)].join("|");
      const seen = new Set(existingCans.map(keyOf));
      // Anche i dati importati da Excel si normalizzano sempre in maiuscolo, come
      // quelli inseriti a mano dal form — coerenza garantita indipendentemente
      // da come sono scritti nel file originale.
      const up2 = v => String(v ?? "").trim().toUpperCase();
      const allRows = aoa.slice(headerRow + 1).map(row => ({
        tipo_linea: up2(at(row, "tipo_linea")),
        nome: up2(at(row, "nome")),
        sku: String(at(row, "sku") || "").replace(/\.0$/, "").trim().toUpperCase(),
        produttore: up2(at(row, "produttore")),
        size: up2(at(row, "size")),
        lingua: up2(at(row, "lingua")),
        top_tab: up2(at(row, "top_tab")),
        piena_vuota: up2(at(row, "piena_vuota")),
        apertura: up2(at(row, "apertura")),
        valore: String(at(row, "valore") ?? "").trim() !== "" ? parseValore(at(row, "valore")) : "",
        photos: ["", "", "", ""],
        ...(isDuplicate ? { is_duplicate: true } : {}),
      }));
      let noTipo = 0, dup = 0;
      const mapped = [];
      for (const r of allRows) {
        if (!r.nome && !r.sku) continue;                  // riga vuota o sezione ("ULTRA (285)") → ignora
        if (!r.tipo_linea) { noTipo++; continue; }         // riga senza TIPO LINEA → saltata
        const k = keyOf(r);
        if (seen.has(k)) { dup++; continue; }              // già in archivio o già vista nel file
        seen.add(k);
        mapped.push(r);
      }
      const skippedMsg = `${dup} già esistenti${noTipo ? `, ${noTipo} saltate (manca TIPO LINEA)` : ""}`;

      if (mapped.length === 0) { setStatus(`✓ Nessuna nuova lattina (${skippedMsg})`); setLoading(false); return; }

      setStatus(`Importo ${mapped.length} nuove lattine su Firebase (${skippedMsg})...`);
      const BATCH = 20;
      let done = 0;
      const all = [];
      for (let i = 0; i < mapped.length; i += BATCH) {
        const batch = mapped.slice(i, i + BATCH);
        const added = await fbBulkAdd(batch);
        all.push(...added);
        done += batch.length;
        setProgress(Math.round(done / mapped.length * 100));
        setStatus(`Importate ${done} / ${mapped.length} lattine...`);
      }
      toast.success(`Import completato: ${mapped.length} lattine aggiunte!`);
      setStatus(`✓ Importate ${mapped.length} lattine (${skippedMsg})`);
      onImportDone(all);
    } catch (err) { setStatus("Errore: " + err.message); toast.error("Errore import"); }
    finally { setLoading(false); }
  };

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 110, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "var(--secondary)", border: "1px solid var(--primary-border)", width: "100%", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--primary-border)" }}>
          <div style={{ flex: 1, ...orbitron, fontSize: 13, color: "var(--primary)", textTransform: "uppercase" }}>{t("import_title")}</div>
          <button onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><X size={14} /></button>
        </div>
        <div style={{ padding: 16 }}>
          <div onClick={() => !loading && fileRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}
            style={{ border: "2px dashed var(--primary-border)", padding: "40px 20px", textAlign: "center", cursor: loading ? "default" : "pointer", ...mono, fontSize: 11, color: "var(--muted-fg)" }}>
            <Upload size={28} style={{ margin: "0 auto 8px", color: "var(--muted-fg)", display: "block" }} />
            {t("import_drop")}<br />
            <span style={{ color: "var(--primary)" }}>{t("import_or_click")}</span><br />
            <span style={{ color: "#444", marginTop: 4, display: "block" }}>.xlsx .xls</span>
          </div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => processFile(e.target.files?.[0])} />
          <p style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", marginTop: 12, lineHeight: 1.6 }}>
            {t("import_note")}
          </p>
          {loading && progress > 0 && (
            <div style={{ marginTop: 10, height: 4, background: "var(--border)", borderRadius: 2 }}>
              <div style={{ height: "100%", background: "var(--primary)", width: `${progress}%`, transition: "width 0.3s", borderRadius: 2 }} />
            </div>
          )}
          {status && <div style={{ marginTop: 10, ...mono, fontSize: 11, color: status.startsWith("Errore") ? "var(--destructive)" : "var(--primary)", display: "flex", alignItems: "center", gap: 8 }}>{loading && <Spinner size={12} />}{status}</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Stats Page ───────────────────────────────────────────────────────────────
const STAT_COLORS = ["#22c55e","#38bdf8","#f59e0b","#a78bfa","#f472b6","#34d399","#fb923c","#60a5fa","#c084fc","#4ade80","#fbbf24","#f87171"];

function groupByStat(arr, key) {
  const map = {};
  arr.forEach(c => { const k = c[key] || "N/D"; map[k] = (map[k] || 0) + 1; });
  return Object.entries(map).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function DonutChart({ data, total, size = 180 }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !window.Chart) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    const top8 = data.slice(0, 8);
    const rest = total - top8.reduce((s, d) => s + d.count, 0);
    chartRef.current = new window.Chart(canvasRef.current, {
      type: "doughnut",
      data: {
        labels: [...top8.map(d => d.name), ...(rest > 0 ? ["Altri"] : [])],
        datasets: [{ data: [...top8.map(d => d.count), ...(rest > 0 ? [rest] : [])], backgroundColor: [...top8.map((_, i) => STAT_COLORS[i % STAT_COLORS.length]), ...(rest > 0 ? ["var(--border)"] : [])], borderWidth: 0, hoverOffset: 6, borderRadius: 2 }]
      },
      options: {
        responsive: false, cutout: "75%",
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#12151a", borderColor: "rgba(34,197,94,0.35)", borderWidth: 1, cornerRadius: 8,
            titleColor: "#22c55e", bodyColor: "#e5e7eb", padding: 10,
            callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw / total * 100)}%)` }
          }
        },
        animation: { duration: 800, easing: "easeOutQuart" }
      }
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [data, total]);
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <canvas ref={canvasRef} width={size} height={size} />
      <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center", pointerEvents: "none" }}>
        <div style={{ ...orbitron, fontSize: Math.round(size * 0.14), color: "var(--fg-strong)", lineHeight: 1 }}>{total}</div>
        <div style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", letterSpacing: "0.1em", marginTop: 2 }}>TOTAL</div>
      </div>
    </div>
  );
}

function StatSection({ title, data, filterKey, onFilter }) {
  const { t, lang } = useLang();
  const [expanded, setExpanded] = useState(false);
  const total = data.reduce((s, d) => s + d.count, 0);
  const max = data[0]?.count || 1;
  const visible = expanded ? data : data.slice(0, 8);
  return (
    <div className="kpi-card" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 14px" }}>
        <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.16em", textTransform: "uppercase", flex: 1 }}>{title}</div>
        <span style={{ ...mono, fontSize: 10, color: "var(--primary)", background: "var(--primary-dim)", border: "1px solid var(--primary-border)", borderRadius: 6, padding: "2px 8px", letterSpacing: "0.08em" }}>{t("stat_voci_tot", data.length, total)}</span>
      </div>
      <div className="stat-section-body" style={{ display: "flex", gap: 24, padding: "0 20px 20px", alignItems: "flex-start" }}>
        <DonutChart data={data} total={total} size={160} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          {visible.map((d, i) => (
            <div key={d.name} onClick={() => onFilter(filterKey, d.name)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 8px", cursor: "pointer", borderRadius: 6, transition: "background 0.12s ease" }}
              onMouseOver={e => e.currentTarget.style.background = "var(--primary-dim)"}
              onMouseOut={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: STAT_COLORS[i % STAT_COLORS.length], flexShrink: 0 }} />
              <div style={{ ...mono, fontSize: 11, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>{filterKey === "lingua" && <Flag lingua={d.name} />}{filterKey === "lingua" ? countryName(d.name, lang) : d.name}</div>
              <div style={{ flex: 2, height: 5, background: "var(--muted)", borderRadius: 3, overflow: "hidden", minWidth: 50 }}>
                <div style={{ height: "100%", borderRadius: 3, background: STAT_COLORS[i % STAT_COLORS.length], width: `${Math.round(d.count / max * 100)}%`, transition: "width 0.6s ease" }} />
              </div>
              <div style={{ ...mono, fontSize: 11, color: "var(--fg-strong)", fontWeight: 700, width: 30, textAlign: "right", flexShrink: 0 }}>{d.count}</div>
              <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", width: 34, textAlign: "right", flexShrink: 0 }}>{Math.round(d.count / total * 100)}%</div>
            </div>
          ))}
          {data.length > 8 && (
            <button onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", background: "transparent", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 12px", marginTop: 6, letterSpacing: "0.1em", alignSelf: "flex-start", cursor: "pointer" }}>
              {expanded ? t("show_less") : t("show_more", data.length - 8)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineChart({ cans }) {
  const { t } = useLang();
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const timelineData = useMemo(() => {
    const map = {};
    cans.forEach(c => {
      const p = parseSku(c.sku);
      if (p === 999999) return;
      const year = Math.floor(p / 100);
      if (year < 1990 || year > 2030) return;
      map[year] = (map[year] || 0) + 1;
    });
    return Object.entries(map).sort((a, b) => +a[0] - +b[0]);
  }, [cans]);
  useEffect(() => {
    if (!canvasRef.current || !window.Chart || !timelineData.length) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    chartRef.current = new window.Chart(canvasRef.current, {
      type: "bar",
      data: {
        labels: timelineData.map(([y]) => y),
        datasets: [{ data: timelineData.map(([, c]) => c), backgroundColor: "rgba(34,197,94,0.18)", borderColor: "#22c55e", borderWidth: 1, borderRadius: 4, hoverBackgroundColor: "rgba(34,197,94,0.4)" }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#12151a", borderColor: "rgba(34,197,94,0.35)", borderWidth: 1, cornerRadius: 8,
            titleColor: "#22c55e", bodyColor: "#e5e7eb",
            callbacks: { title: ([ctx]) => `Anno ${ctx.label}`, label: ctx => ` ${ctx.raw} lattine` }
          }
        },
        scales: {
          x: { grid: { color: "rgba(148,163,184,0.08)" }, ticks: { color: "#8a94a3", font: { family: "Inter, sans-serif", size: 10 } }, border: { color: "rgba(148,163,184,0.15)" } },
          y: { grid: { color: "rgba(148,163,184,0.08)" }, ticks: { color: "#8a94a3", font: { family: "Inter, sans-serif", size: 10 }, stepSize: 1 }, border: { color: "rgba(148,163,184,0.15)" } }
        },
        animation: { duration: 1000, easing: "easeOutQuart" }
      }
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [timelineData]);
  if (!timelineData.length) return null;
  // L'anno in corso è quasi sempre incompleto: confrontarlo con un anno pieno
  // darebbe sempre un calo enorme e fuorviante. Il trend usa quindi gli ultimi
  // due anni già conclusi, ignorando l'anno corrente se presente in timeline.
  const thisYear = new Date().getFullYear();
  const completedYears = timelineData.filter(([y]) => +y < thisYear);
  const m = completedYears.length;
  const trend = m >= 2 ? (() => {
    const [, lastCount] = completedYears[m - 1];
    const [prevYear, prevCount] = completedYears[m - 2];
    if (!prevCount) return null;
    const pct = Math.round((lastCount - prevCount) / prevCount * 100);
    return { pct, up: pct > 0, flat: pct === 0, prevYear };
  })() : null;
  return (
    <div className="kpi-card" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 20px 20px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.16em", textTransform: "uppercase" }}>{t("timeline_title")}</div>
        {trend && (
          <div style={{ display: "flex", alignItems: "center", gap: 5, ...mono, fontSize: 11, color: trend.flat ? "var(--muted-fg)" : trend.up ? "var(--primary)" : "var(--destructive)" }}>
            {!trend.flat && (trend.up ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
            {trend.flat ? "=" : `${trend.up ? "+" : ""}${trend.pct}%`}
            <span style={{ color: "var(--muted-fg)", fontWeight: 400 }}>{t("timeline_trend_label", trend.prevYear)}</span>
          </div>
        )}
      </div>
      <div style={{ height: 160 }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function StatsPage({ cans, page, setPage, onFilterApply, admin, user, onLogout, onToggleAdmin, loginBusy, onShowRules, onSetPassword, onMigratePrices, migratingPrices, onUppercaseData, uppercasingData }) {
  const { t, lang } = useLang();
  const [scriptLoaded, setScriptLoaded] = useState(!!window.Chart);
  useEffect(() => {
    if (window.Chart) { setScriptLoaded(true); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    s.onload = () => setScriptLoaded(true);
    document.head.appendChild(s);
  }, []);

  const data = useMemo(() => ({
    total: cans.length,
    withPhoto: cans.filter(c => c.photos?.some(p => p)).length,
    full: cans.filter(c => c.piena_vuota === "FULL").length,
    empty: cans.filter(c => c.piena_vuota === "EMPTY").length,
    lines: new Set(cans.map(c => c.tipo_linea).filter(Boolean)).size,
    countries: new Set(cans.map(c => c.lingua).filter(Boolean)).size,
    totalValue: cans.reduce((s, c) => s + parseValore(c.valore), 0),
    valued: cans.filter(c => parseValore(c.valore) > 0).length,
    withCondition: cans.filter(c => c.condizione).length,
    withNote: cans.filter(c => (c.note_it || c.note_en || c.note) && (c.note_it || c.note_en || c.note).trim()).length,
    byLingua: groupByStat(cans, "lingua"), bySize: groupByStat(cans, "size"),
    byProd: groupByStat(cans, "produttore"), byLine: groupByStat(cans, "tipo_linea"),
    byApertura: groupByStat(cans, "apertura"), byTopTab: groupByStat(cans, "top_tab"),
  }), [cans]);

  const photoPct = data.total ? Math.round(data.withPhoto / data.total * 100) : 0;
  const valuePct = data.total ? Math.round(data.valued / data.total * 100) : 0;
  const conditionPct = data.total ? Math.round(data.withCondition / data.total * 100) : 0;
  const notePct = data.total ? Math.round(data.withNote / data.total * 100) : 0;

  const handleFilter = (key, value) => {
    const map = { lingua: "tipo", size: "size", produttore: "produttore", tipo_linea: "tipo", apertura: "apertura", piena_vuota: "piena_vuota" };
    const mapped = map[key]; if (mapped) onFilterApply && onFilterApply(mapped, value);
    setPage("vault");
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 80 }}>
      <AppHeader page={page} setPage={setPage} admin={admin} user={user} onLogout={onLogout} onToggleAdmin={onToggleAdmin} loginBusy={loginBusy} onShowRules={onShowRules} onSetPassword={onSetPassword} onMigratePrices={onMigratePrices} migratingPrices={migratingPrices} onUppercaseData={onUppercaseData} uppercasingData={uppercasingData} />

      {/* KPI cards */}
      <div style={{ padding: "20px 20px 0" }}>
        <div className="kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {[
            { l: t("kpi_totale"), v: data.total, c: "var(--primary)", sub: t("kpi_totale_sub"), Icon: Database },
            { l: t("kpi_linee"), v: data.lines, c: "#60a5fa", sub: "product lines", Icon: Layers },
            { l: t("kpi_paesi"), v: data.countries, c: "#60a5fa", sub: t("kpi_paesi_sub"), Icon: Globe },
            { l: t("kpi_con_foto"), v: data.withPhoto, c: "var(--primary)", sub: t("kpi_pct_total", photoPct), Icon: Camera },
            { l: t("kpi_vuote"), v: data.empty, c: "var(--primary)", sub: data.total ? t("kpi_pct_total", Math.round(data.empty / data.total * 100)) : "", Icon: Package },
            { l: t("kpi_piene"), v: data.full, c: "var(--yellow)", sub: data.total ? t("kpi_pct_total", Math.round(data.full / data.total * 100)) : "", Icon: PackageCheck },
            ...(admin ? [{ l: t("kpi_valore"), v: fmtValore(data.totalValue, lang), c: "var(--primary)", sub: t("kpi_valued", data.valued), Icon: Euro, wide: true }] : []),
          ].map(s => (
            <div key={s.l} className={`kpi-card${s.wide ? " kpi-wide" : ""}`} style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
              <div className="kpi-icon" style={{ width: 30, height: 30, borderRadius: 8, background: `color-mix(in srgb, ${s.c} 14%, transparent)`, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 12, flexShrink: 0 }}>
                <s.Icon size={15} style={{ color: s.c }} />
              </div>
              <div className="kpi-text">
                <div className="kpi-value" style={{ ...orbitron, fontSize: "clamp(16px, 2.2vw, 26px)", color: "var(--fg-strong)", lineHeight: 1, marginBottom: 6, whiteSpace: "nowrap" }}>{s.v}</div>
                <div style={{ ...mono, fontSize: 10, letterSpacing: "0.14em", color: "var(--muted-fg)", textTransform: "uppercase" }}>{s.l}</div>
                {s.sub && <div className="kpi-sub" style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", opacity: 0.65, marginTop: 3 }}>{s.sub}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Data coverage */}
      <div style={{ padding: "20px" }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "18px 20px" }}>
          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.15em", color: "var(--muted-fg)", textTransform: "uppercase", marginBottom: 16 }}>{t("coverage_title")}</div>
          {[
            { l: t("coverage_foto"), pct: photoPct, cur: data.withPhoto, Icon: Camera },
            ...(admin ? [{ l: t("coverage_valore"), pct: valuePct, cur: data.valued, Icon: Euro }] : []),
            { l: t("coverage_condizione"), pct: conditionPct, cur: data.withCondition, Icon: AlertTriangle },
            { l: t("coverage_note"), pct: notePct, cur: data.withNote, Icon: Pencil },
          ].map((r, i) => {
            const barColor = r.pct >= 70 ? "var(--primary)" : r.pct >= 30 ? "var(--yellow)" : "var(--destructive)";
            return (
              <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 12, marginTop: i ? 14 : 0 }}>
                <r.Icon size={13} style={{ color: "var(--muted-fg)", flexShrink: 0 }} />
                <div style={{ ...mono, fontSize: 10, letterSpacing: "0.1em", color: "var(--muted-fg)", textTransform: "uppercase", width: 78, flexShrink: 0 }}>{r.l}</div>
                <div style={{ flex: 1, height: 6, background: "var(--muted)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 3, background: barColor, width: `${r.pct}%`, transition: "width 1s ease" }} />
                </div>
                <div style={{ ...orbitron, fontSize: 14, color: barColor, width: 42, textAlign: "right", flexShrink: 0 }}>{r.pct}%</div>
                <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", opacity: 0.75, width: 74, textAlign: "right", flexShrink: 0 }}>{r.cur} / {data.total}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Charts */}
      {!scriptLoaded
        ? <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><Spinner /></div>
        : (
          <div style={{ padding: "0 20px 20px" }}>
            <TimelineChart cans={cans} />
            {[
              { title: "BY COUNTRY / LANGUAGE", data: data.byLingua, key: "lingua" },
              { title: "BY LINE", data: data.byLine, key: "tipo_linea" },
              { title: "BY MANUFACTURER", data: data.byProd, key: "produttore" },
              { title: "BY SIZE", data: data.bySize, key: "size" },
              { title: "BY APERTURA", data: data.byApertura, key: "apertura" },
              { title: "BY TOP/TAB", data: data.byTopTab, key: "top_tab" },
            ]
              .filter(s => s.data.length > 0)
              .map(s => <StatSection key={s.key} title={s.title} data={s.data} filterKey={s.key} onFilter={handleFilter} />)
            }
          </div>
        )
      }
    </div>
  );
}

// ─── World Map ────────────────────────────────────────────────────────────────
const LINGUA_TO_ISO = { "ITALY":"IT","ITALIA":"IT","USA":"US","GERMANY":"DE","GERMANIA":"DE","SPAIN":"ES","SPAGNA":"ES","FRANCE":"FR","FRANCIA":"FR","UK":"GB","REGNO UNITO":"GB","NETHERLANDS":"NL","OLANDA":"NL","BENELUX":"NL","BELGIUM":"BE","BELGIO":"BE","AUSTRIA":"AT","SWITZERLAND":"CH","SVIZZERA":"CH","PORTUGAL":"PT","PORTOGALLO":"PT","SWEDEN":"SE","SVEZIA":"SE","NORWAY":"NO","NORVEGIA":"NO","FINLAND":"FI","FINLANDIA":"FI","DENMARK":"DK","DANIMARCA":"DK","POLAND":"PL","POLONIA":"PL","CZECH REPUBLIC":"CZ","CZECH":"CZ","HUNGARY":"HU","UNGHERIA":"HU","ROMANIA":"RO","BULGARIA":"BG","GREECE":"GR","GRECIA":"GR","TURKEY":"TR","TURCHIA":"TR","RUSSIA":"RU","UKRAINE":"UA","UCRAINA":"UA","JAPAN":"JP","GIAPPONE":"JP","CHINA":"CN","CINA":"CN","SOUTH KOREA":"KR","AUSTRALIA":"AU","BRAZIL":"BR","BRASILE":"BR","MEXICO":"MX","MESSICO":"MX","CANADA":"CA","ARGENTINA":"AR","CHILE":"CL","CILE":"CL","SOUTH AFRICA":"ZA","INDIA":"IN","IRELAND":"IE","IRLANDA":"IE","CROATIA":"HR","SLOVAKIA":"SK","SLOVENIA":"SI","SERBIA":"RS","LUXEMBOURG":"LU","MALTA":"MT","CYPRUS":"CY","ESTONIA":"EE","LATVIA":"LV","LITHUANIA":"LT","BELARUS":"BY","KAZAKHSTAN":"KZ","ISRAEL":"IL","UAE":"AE","SAUDI ARABIA":"SA","EGYPT":"EG","MOROCCO":"MA","NIGERIA":"NG","KENYA":"KE","NEW ZEALAND":"NZ","THAILAND":"TH","VIETNAM":"VN","PHILIPPINES":"PH","INDONESIA":"ID","MALAYSIA":"MY","SINGAPORE":"SG","COLOMBIA":"CO","PERU":"PE","ECUADOR":"EC","VENEZUELA":"VE","ICELAND":"IS","NORTH MACEDONIA":"MK","ALBANIA":"AL","HONG KONG":"HK","TAIWAN":"TW","SRI LANKA":"LK","GEORGIA":"GE","JORDAN":"JO","QATAR":"QA","TANZANIA":"TZ","JAMAICA":"JM","MOLDOVA":"MD","CAMBODIA":"KH","DOMINICAN REPUBLIC":"DO","COSTA RICA":"CR","GUATEMALA":"GT","URUGUAY":"UY","TRINIDAD AND TOBAGO":"TT","AZERBAIJAN":"AZ","AFGHANISTAN":"AF","ITALY/AUSTRIA":"IT","SPAIN/PORTUGAL":"ES","GERMANY/AUSTRIA":"DE","UK/NETHERLANDS":"GB","SWEDEN/NORWAY":"SE","CZECH REPUBLIC/SLOVAKIA":"CZ","SLOVENIA/CROATIA":"SI","BENELUX (NL)":"NL","BENELUX (BE)":"BE","USA (UTAH)":"US","USA/CARIBBEAN":"US","CARIBBEAN":"TT","INDONESIA/MALAYSIA":"ID","SERBIA/NORTH MACEDONIA":"RS","LITHUANIA/ESTONIA/LATVIA":"LT","ROMANIA/ALBANIA":"RO","BULGARIA/ALBANIA":"BG","BULGARIA/CYPRUS":"BG","NORTH MACEDONIA/SERBIA/MONTENEGRO":"MK","NETHERLANDS (BENELUX)":"NL","UKRAINE/MOLDOVA":"UA","ALBANIA/KOSOVO":"AL","ALBANIA/ROMANIA":"AL","BOLIVIA/PARAGUAY":"BO","AUSTRALIA/NEW ZEALAND":"AU","SWEDEN/NETHERLANDS":"SE","PARAGUAY":"PY","BOLIVIA":"BO","MONTENEGRO":"ME","KOSOVO":"XK","OMAN":"OM","BAHRAIN":"BH","DANMARK":"DK","CZECHOSLOVAKIA":"CZ" };
const ISO_TO_NAME = { IT:"Italy",US:"USA",DE:"Germany",ES:"Spain",FR:"France",GB:"UK",NL:"Netherlands",BE:"Belgium",AT:"Austria",CH:"Switzerland",PT:"Portugal",SE:"Sweden",NO:"Norway",FI:"Finland",DK:"Denmark",PL:"Poland",CZ:"Czech Republic",HU:"Hungary",RO:"Romania",BG:"Bulgaria",GR:"Greece",TR:"Turkey",RU:"Russia",UA:"Ukraine",JP:"Japan",CN:"China",KR:"South Korea",AU:"Australia",BR:"Brazil",MX:"Mexico",CA:"Canada",AR:"Argentina",CL:"Chile",ZA:"South Africa",IN:"India",IE:"Ireland",HR:"Croatia",SK:"Slovakia",SI:"Slovenia",RS:"Serbia",LU:"Luxembourg",MT:"Malta",CY:"Cyprus",EE:"Estonia",LV:"Latvia",LT:"Lithuania",BY:"Belarus",KZ:"Kazakhstan",IL:"Israel",AE:"UAE",SA:"Saudi Arabia",EG:"Egypt",MA:"Morocco",NG:"Nigeria",KE:"Kenya",NZ:"New Zealand",TH:"Thailand",VN:"Vietnam",PH:"Philippines",ID:"Indonesia",MY:"Malaysia",SG:"Singapore",CO:"Colombia",PE:"Peru",EC:"Ecuador",VE:"Venezuela",IS:"Iceland",MK:"N. Macedonia",AL:"Albania",HK:"Hong Kong",TW:"Taiwan",LK:"Sri Lanka",GE:"Georgia",JO:"Jordan",QA:"Qatar",TZ:"Tanzania",JM:"Jamaica",MD:"Moldova",KH:"Cambodia",DO:"Dom. Republic",CR:"Costa Rica",GT:"Guatemala",UY:"Uruguay",BO:"Bolivia",TT:"Trinidad",AZ:"Azerbaijan",AF:"Afghanistan",PY:"Paraguay",ME:"Montenegro",XK:"Kosovo",OM:"Oman",BH:"Bahrain" };

// Varianti che condividono l'ISO di un altro paese ma hanno un design/etichetta lattina
// distinto (es. lo Utah impone una grafica diversa dal resto degli USA): la traduzione IT
// generica per ISO le appiattirebbe (es. "USA (UTAH)" → "USA"), quindi vanno preservate.
const LINGUA_SPECIAL_IT = { "USA (UTAH)": "USA (Utah)", "CARIBBEAN": "Caraibi" };
const LINGUA_SPECIAL_EN = { "USA (UTAH)": "USA (Utah)", "CARIBBEAN": "Caribbean" };

// Nome paese localizzato: risolve il valore grezzo "lingua" (già perlopiù inglese, ma con
// maiuscole/minuscole non uniformi da riga a riga nei dati importati) tramite ISO, così si
// mostra sempre un nome scritto in modo consistente — in entrambe le lingue, non solo in
// italiano — invece del valore grezzo così com'è salvato.
function countryName(lingua, lang) {
  if (!lingua) return lingua;
  // Il resto del sito è scritto tutto maiuscolo (etichette, badge, bottoni):
  // il nome del paese risolto viene sempre riportato maiuscolo per restare
  // coerente con quello stile, invece che in Title Case.
  return countryNameRaw(lingua, lang).toUpperCase();
}
function countryNameRaw(lingua, lang) {
  const upper = lingua.trim().toUpperCase();
  const specials = lang === "it" ? LINGUA_SPECIAL_IT : LINGUA_SPECIAL_EN;
  if (specials[upper]) return specials[upper];
  const isos = normalizeLinguaAll(lingua);
  const dict = lang === "it" ? ISO_TO_NAME_IT : ISO_TO_NAME;
  if (isos.length === 1 && dict[isos[0]]) return dict[isos[0]];
  // Valore combinato (es. "SPAIN/PORTUGAL"): traduce ogni parte singolarmente
  // e le riunisce, così resta scritto in modo uniforme rispetto ai paesi
  // singoli invece di restare tutto maiuscolo come nel dato grezzo.
  if (!upper.includes("(")) {
    const segments = lingua.trim().split(/\s*(?:\/|->|-|&)\s*/).filter(Boolean);
    if (segments.length > 1) {
      return segments.map(seg => {
        const iso = LINGUA_TO_ISO[seg.trim().toUpperCase()];
        return (iso && dict[iso]) || seg;
      }).join("/");
    }
  }
  return lingua;
}

function normalizeLinguaAll(lingua) {
  if (!lingua) return [];
  const full = lingua.trim().toUpperCase(), results = new Set();
  if (LINGUA_TO_ISO[full]) results.add(LINGUA_TO_ISO[full]);
  if (!full.includes("(")) {
    full.split(/\s*(?:\/|->|-|&)\s*/).forEach(p => { const k = p.trim(); if (LINGUA_TO_ISO[k]) results.add(LINGUA_TO_ISO[k]); });
  }
  return [...results];
}

// ─── isOriginal filter ────────────────────────────────────────────────────────
const EXCLUDED_KEYWORDS = ['zero sugar', 'export', 'cuba-lima', 'tour', ' xg', 'hitman', 'spring'];
function isOriginal(can) {
  const t = (can.tipo_linea || '').toUpperCase().trim();
  const nome = (can.nome || '').toLowerCase();
  if (nome.includes('basket') || nome.includes('promo') || t.includes('BASKET') || t.includes('PROMO')) return false;
  if (t.includes('BLACK')) {
    const hasOg = t.includes('OG') || t.includes('ORIGINAL') || nome.includes('og') || nome.includes('original');
    if (!hasOg) return false;
    if (EXCLUDED_KEYWORDS.some(kw => nome.includes(kw))) return false;
    return true;
  }
  if (t === 'ASIA' || t.startsWith('ASIA ') || t.includes(' ASIA')) {
    const hasOg = t.includes('OG') || t.includes('ORIGINAL') || nome.includes('og') || nome.includes('original');
    if (!hasOg) return false;
    return true;
  }
  const isOg = t === 'ORIGINAL' || t === 'OG' || t.startsWith('OG ') || t.startsWith('ORIGINAL ') || t.includes(' OG') || t.includes(' ORIGINAL');
  if (!isOg) return false;
  if (t.includes('PROMO') || t.includes('EXPORT') || t.includes('ZERO')) return false;
  if (EXCLUDED_KEYWORDS.some(kw => nome.includes(kw))) return false;
  return true;
}

// Lista completa paesi mancanti (lingua value → iso, nome, note)
// refPhotos: foto di riferimento (Cloudinary) della lattina che manca, per visualizzarla prima di trovarla
const MISSING_COUNTRIES = [
  { lingua: 'TANZANIA',                iso: 'TZ', name: 'Tanzania',    note: 'Mancante', noteEn: 'Missing', partial: false, refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788524676/turrgozennwf6ikacsjx.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788524677/yxojs56qbtngc55nssyg.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788524678/mjbpwlc4zqxmkpiafurd.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788524679/qti0ov4ungrgsdls22fu.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788524680/dtfwqinwsu95bmlzqzzi.jpg",
  ] },
  { lingua: 'UKRAINE/MOLDOVA',         iso: 'MD', iso2: 'UA', name: 'UK/MD', note: 'In arrivo', noteEn: 'On the way', partial: false, status: 'on_the_way', refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788525265/ovqhw6guocr7tuquk3l3.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788525267/hwtfyr3dksjtpgxhd8jw.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788525267/zg7cy810djubp9rawqve.jpg",
  ] },
  { lingua: 'INDONESIA',               iso: 'ID', name: 'Indonesia',   note: 'Trovata', noteEn: 'Found', partial: false, status: 'found', refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788526044/wkt9idksuimgovzkqulq.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788526045/sj1anrfsawblor2p8kh8.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788526046/rilbxccq5qmhw3pkudjb.jpg",
  ] },
  { lingua: 'THAILAND',                iso: 'TH', name: 'Thailand',    note: 'Trovata', noteEn: 'Found', partial: false, status: 'found', refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788523990/nruv0swrdy0urw51d5ku.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788523992/ok1ih2tmiltzbr09jfuq.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788523993/urvntpblrsorieeh8jjg.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788523994/r2vjswag4jdhhc4igkwl.jpg",
  ] },
  { lingua: 'JAMAICA',                 iso: 'JM', name: 'Jamaica',     note: 'Mancante', noteEn: 'Missing', partial: false, refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788527918/e6dob6wek9hfa9ftfobi.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788527920/ychboktmir1lkmzcesxf.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788527920/v6hjtcylroh6xqumous9.jpg",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788527921/w7fm5t3fgt2lael8kyv3.jpg",
  ] },
  { lingua: 'PANAMA',                  iso: 'PA', name: 'Panama',     note: 'Mancante', noteEn: 'Missing', partial: false, refPhotos: [
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788735221/vyhyybxoobj1jkfirjod.png",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788735220/bzjwt3lojyxpbhaiaypk.webp",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788735219/tc4w30niiajujooouf9t.webp",
    "https://res.cloudinary.com/dy5c9xbxy/image/upload/v1788735219/hboldh0uhx3iwt6uzszt.jpg",
  ] },
  { lingua: 'SPAIN/PORTUGAL',          iso: 'PT', name: 'Portugal',    note: 'Solo ES/PT', noteEn: 'ES/PT only', partial: true,  refPhotos: [] },
  { lingua: 'CZECH REPUBLIC/SLOVAKIA', iso: 'SK', name: 'Slovakia',    note: 'Solo CZ/SK', noteEn: 'CZ/SK only', partial: true,  refPhotos: [] },
  { lingua: 'BOLIVIA/PARAGUAY',        iso: 'PY', name: 'Paraguay',    note: 'In arrivo', noteEn: 'On the way', partial: true, status: 'on_the_way', refPhotos: [], color: 'var(--primary)', noteSize: 11 },
];

function WorldMap({ cans, page, setPage, onSelectCan, admin, user, onLogout, onToggleAdmin, loginBusy, onShowRules, onSetPassword, onMigratePrices, migratingPrices, onUppercaseData, uppercasingData }) {
  const { t, lang } = useLang();
  const [geoData, setGeoData] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [search, setSearch] = useState("");
  const [filterPaese, setFilterPaese] = useState("");
  const [filterSize, setFilterSize] = useState("");
  const [filterStato, setFilterStato] = useState("");
  const [filterProduttore, setFilterProduttore] = useState("");
  const [photoOnly, setPhotoOnly] = useState(false);
  const [noPhoto, setNoPhoto] = useState(false);
  const [valuedOnly, setValuedOnly] = useState(false);
  const [noValue, setNoValue] = useState(false);
  const [sort, setSort] = useState("default");
  const [refPhotoView, setRefPhotoView] = useState(null);
  const [zoomIndex, setZoomIndex] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState("center center");
  const [mapFilterIso, setMapFilterIso] = useState(null);
  const [view, setView] = useVaultView();
  const gridRef = useRef(null);

  useEffect(() => {
    fetch("https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson")
      .then(r => r.json()).then(setGeoData).catch(() => setGeoData(null));
  }, []);

  const originals = useMemo(() => cans.filter(isOriginal), [cans]);

  const { countryData, ownedISOs, totalCountries } = useMemo(() => {
    const map = {};
    originals.forEach(can => {
      normalizeLinguaAll(can.lingua).forEach(iso => {
        if (!map[iso]) map[iso] = { count: 0, cans: [] };
        map[iso].count++; map[iso].cans.push(can);
      });
    });
    return { countryData: map, ownedISOs: new Set(Object.keys(map)), totalCountries: Object.keys(map).length };
  }, [originals]);

  // Paesi mancanti dinamici
  // - Partial (giallo): spariscono solo quando si aggiunge una lattina DIRETTA (non combinata)
  // - Missing (rosso): spariscono quando si aggiunge qualsiasi lattina di quel paese
  const missingCountries = useMemo(() => {
    return MISSING_COUNTRIES.slice().sort((a, b) => (a.partial === b.partial ? 0 : a.partial ? 1 : -1)).filter(mc => {
      if (mc.partial) {
        // Rimane in lista finché non c'è una lattina con lingua ESATTA del paese
        const directLingue = ['PORTUGAL','PORTOGALLO','SLOVAKIA','PARAGUAY'];
        const hasDirect = originals.some(c => {
          const l = (c.lingua || '').toUpperCase().trim();
          if (mc.iso === 'PT') return l === 'PORTUGAL' || l === 'PORTOGALLO';
          if (mc.iso === 'SK') return l === 'SLOVAKIA';
          if (mc.iso === 'PY') return l === 'PARAGUAY';
          return false;
        });
        return !hasDirect;
      } else {
        return !ownedISOs.has(mc.iso);
      }
    });
  }, [ownedISOs, originals]);

  const partialISOs = useMemo(() => {
    const s = new Set();
    missingCountries.filter(mc => mc.partial).forEach(mc => s.add(mc.iso));
    return s;
  }, [missingCountries]);

  const missingISOs = useMemo(() => {
    const s = new Set();
    missingCountries.filter(mc => !mc.partial).forEach(mc => s.add(mc.iso));
    return s;
  }, [missingCountries]);

  // Filtri "a cascata": ogni tendina/chip mostra solo le opzioni compatibili
  // con tutti gli altri filtri già attivi (se stessa esclusa).
  const applyMapFilters = (skip = []) => {
    const sk = new Set(skip);
    let r = [...originals];
    if (mapFilterIso && !sk.has("mapFilterIso")) { const isoCans = countryData[mapFilterIso]?.cans; r = isoCans ? [...isoCans] : []; }
    if (search && !sk.has("search")) { const s = search.toLowerCase(); r = r.filter(c => (c.nome || '').toLowerCase().includes(s) || (c.sku || '').toLowerCase().includes(s) || (c.lingua || '').toLowerCase().includes(s)); }
    if (filterPaese && !sk.has("filterPaese")) r = r.filter(c => c.lingua === filterPaese);
    if (filterSize && !sk.has("filterSize")) r = r.filter(c => c.size === filterSize);
    if (filterStato && !sk.has("filterStato")) r = r.filter(c => c.piena_vuota === filterStato);
    if (filterProduttore && !sk.has("filterProduttore")) r = r.filter(c => c.produttore === filterProduttore);
    if (photoOnly && !sk.has("photo")) r = r.filter(c => c.photos?.some(p => p));
    if (noPhoto && !sk.has("photo")) r = r.filter(c => !c.photos?.some(p => p));
    if (valuedOnly && !sk.has("value")) r = r.filter(c => parseValore(c.valore) > 0);
    if (noValue && !sk.has("value")) r = r.filter(c => !(parseValore(c.valore) > 0));
    return r;
  };
  const allPaesi = [...new Set(applyMapFilters(["filterPaese"]).map(c => c.lingua).filter(Boolean))].map(v => ({ value: v, label: countryName(v, lang) })).sort((a, b) => a.label.localeCompare(b.label));
  const allSizes = [...new Set(applyMapFilters(["filterSize"]).map(c => c.size).filter(Boolean))].sort((a, b) => parseFloat(a) - parseFloat(b));
  const allProds = [...new Set(applyMapFilters(["filterProduttore"]).map(c => c.produttore).filter(Boolean))].sort();
  const cFull = applyMapFilters(["filterStato"]).filter(c => c.piena_vuota === "FULL").length;
  const cEmpty = applyMapFilters(["filterStato"]).filter(c => c.piena_vuota === "EMPTY").length;
  const cPhoto = applyMapFilters(["photo"]).filter(c => c.photos?.some(p => p)).length;
  const cNoPhoto = applyMapFilters(["photo"]).filter(c => !c.photos?.some(p => p)).length;
  const cValued = applyMapFilters(["value"]).filter(c => parseValore(c.valore) > 0).length;
  const cNoValue = applyMapFilters(["value"]).filter(c => !(parseValore(c.valore) > 0)).length;
  const chipStyle = (active, col = "var(--primary)") => ({ ...mono, fontSize: 11, border: "1px solid", padding: "5px 10px", letterSpacing: "0.08em", background: active ? "var(--primary-dim)" : "transparent", borderColor: active ? col : "var(--border)", color: active ? col : "var(--muted-fg)", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" });
  const cnt = n => <span style={{ fontWeight: 700, opacity: 0.85 }}>{n}</span>;

  const filteredCans = useMemo(() => {
    let r = [...originals];
    if (mapFilterIso) { const isoCans = countryData[mapFilterIso]?.cans; r = isoCans ? [...isoCans] : []; }
    if (search) { const s = search.toLowerCase(); r = r.filter(c => (c.nome || '').toLowerCase().includes(s) || (c.sku || '').toLowerCase().includes(s) || (c.lingua || '').toLowerCase().includes(s)); }
    if (filterPaese) r = r.filter(c => c.lingua === filterPaese);
    if (filterSize) r = r.filter(c => c.size === filterSize);
    if (filterStato) r = r.filter(c => c.piena_vuota === filterStato);
    if (filterProduttore) r = r.filter(c => c.produttore === filterProduttore);
    if (photoOnly) r = r.filter(c => c.photos?.some(p => p));
    if (noPhoto) r = r.filter(c => !c.photos?.some(p => p));
    if (valuedOnly) r = r.filter(c => parseValore(c.valore) > 0);
    if (noValue) r = r.filter(c => !(parseValore(c.valore) > 0));
    if (sort === "name_az") r.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    else if (sort === "name_za") r.sort((a, b) => (b.nome || "").localeCompare(a.nome || ""));
    else if (sort === "sku_asc") r.sort((a, b) => parseSku(a.sku) - parseSku(b.sku));
    else if (sort === "sku_desc") r.sort((a, b) => parseSku(b.sku) - parseSku(a.sku));
    else if (sort === "tipo") r.sort((a, b) => (a.tipo_linea || "").localeCompare(b.tipo_linea || ""));
    else if (sort === "valore_desc") r.sort((a, b) => parseValore(b.valore) - parseValore(a.valore));
    else if (sort === "valore_asc") r.sort((a, b) => parseValore(a.valore) - parseValore(b.valore));
    else if (sort === "recent") r.sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
    return r;
  }, [originals, mapFilterIso, countryData, search, filterPaese, filterSize, filterStato, filterProduttore, photoOnly, noPhoto, valuedOnly, noValue, sort]);

  const handleCountryClick = iso => {
    setMapFilterIso(iso);
    setFilterPaese("");
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 80 }}>
      <AppHeader page={page} setPage={setPage} admin={admin} user={user} onLogout={onLogout} onToggleAdmin={onToggleAdmin} loginBusy={loginBusy} onShowRules={onShowRules} onSetPassword={onSetPassword} onMigratePrices={onMigratePrices} migratingPrices={migratingPrices} onUppercaseData={onUppercaseData} uppercasingData={uppercasingData} />

      {/* Stats bar */}
      <div className="map-stats-grid" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", background: "var(--secondary)", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "center" }}>
        {[
          { Icon: GlassWater, v: originals.length, l: t("map_original"), c: "var(--primary)" },
          { Icon: Globe, v: totalCountries, l: t("kpi_paesi"), c: "#60a5fa" },
          { Icon: Package, v: originals.filter(c => c.piena_vuota === "EMPTY").length, l: t("kpi_vuote"), c: "var(--primary)" },
          { Icon: PackageCheck, v: originals.filter(c => c.piena_vuota === "FULL").length, l: t("kpi_piene"), c: "var(--yellow)" },
        ].map(({ Icon, v, l, c }) => (
          <div key={l} className="kpi-card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: `color-mix(in srgb, ${c} 14%, transparent)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon size={13} style={{ color: c }} />
            </div>
            <span style={{ ...orbitron, fontSize: 19, color: "var(--fg-strong)" }}>{v}</span>
            <span style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.12em", textTransform: "uppercase" }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Mappa */}
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ width: "100%", height: "min(55vw,48vh)", minHeight: 200, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
          {!geoData
            ? <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)" }}>{t("map_loading")}</div>
            : <MapSVG geoData={geoData} ownedISOs={ownedISOs} missingISOs={missingISOs} partialISOs={partialISOs} countryData={countryData} tooltip={tooltip} setTooltip={setTooltip} onCountryClick={handleCountryClick} />
          }
        </div>
        <div style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", opacity: 0.6, textAlign: "center", marginTop: 8, letterSpacing: "0.05em" }}>{t("map_click_hint")}</div>
      </div>

      {/* Paesi mancanti, raggruppati per stato: mancanti / trovate ma mancanti / in arrivo */}
      {missingCountries.length > 0 && (
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: 14 }}>
          {[
            { key: "missing", color: "var(--destructive)", titleFn: n => t("map_section_missing", n), items: missingCountries.filter(mc => (mc.status || "missing") === "missing") },
            { key: "found", color: "var(--yellow)", titleFn: n => t("map_section_found", n), items: missingCountries.filter(mc => mc.status === "found") },
            { key: "on_the_way", color: "var(--primary)", titleFn: n => t("map_section_ontheway", n), items: missingCountries.filter(mc => mc.status === "on_the_way") },
          ].filter(section => section.items.length > 0).map(section => (
            <div key={section.key} className="kpi-card" style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <AlertTriangle size={13} style={{ color: section.color }} />
                <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", letterSpacing: "0.15em", textTransform: "uppercase" }}>{section.titleFn(section.items.length)}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
                {section.items.map(mc => (
                  <div key={mc.iso} style={{ background: "var(--muted)", border: "1px solid var(--border)", borderLeft: `3px solid ${section.color}`, borderRadius: 8, padding: "8px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                    {mc.iso2 ? (
                      <div style={{ width: 20, height: 15, borderRadius: 2, overflow: "hidden", display: "flex", flexShrink: 0 }}>
                        <img src={`https://flagcdn.com/20x15/${mc.iso2.toLowerCase()}.png`} alt={mc.iso2} style={{ width: 10, height: 15, objectFit: "cover" }} onError={e => e.target.style.display='none'} />
                        <img src={`https://flagcdn.com/20x15/${mc.iso.toLowerCase()}.png`} alt={mc.iso} style={{ width: 10, height: 15, objectFit: "cover" }} onError={e => e.target.style.display='none'} />
                      </div>
                    ) : (
                      <img src={`https://flagcdn.com/20x15/${mc.iso.toLowerCase()}.png`} alt={mc.iso} style={{ width: 20, height: 15, borderRadius: 2, objectFit: "cover", flexShrink: 0 }} onError={e => e.target.style.display='none'} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ ...mono, fontSize: 11, color: section.color, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mc.name}</div>
                      <div style={{ ...mono, fontSize: mc.noteSize || 9, color: "var(--muted-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lang === "en" ? (mc.noteEn || mc.note) : mc.note}</div>
                      {mc.refPhotos?.length > 0 ? (
                        <button onClick={() => setRefPhotoView(mc)} style={{ ...mono, fontSize: 9, color: "var(--primary)", textDecoration: "underline", background: "none", border: "none", padding: 0, marginTop: 2, cursor: "pointer", letterSpacing: "0.05em" }}>
                          {t("see_photo")}
                        </button>
                      ) : section.key !== "on_the_way" && (
                        <div style={{ ...mono, fontSize: 9, color: "var(--destructive)", marginTop: 2, letterSpacing: "0.05em" }}>
                          {t("no_photo")}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filtri */}
      <div ref={gridRef} style={{ borderBottom: "1px solid var(--border)", padding: "10px 16px", background: "var(--secondary)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="map-filters-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, alignItems: "center" }}>
          <div className="mf-search" style={{ position: "relative", display: "flex", alignItems: "center", minWidth: 0 }}>
            <Search size={12} style={{ position: "absolute", left: 8, color: "var(--muted-fg)" }} />
            <input type="text" placeholder={t("map_search_ph")} value={search} onChange={e => setSearch(e.target.value)}
              style={{ ...mono, fontSize: 11, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "6px 8px 6px 24px", width: "100%" }} />
          </div>
          <div className="mf-paese"><FilterSelect value={filterPaese} onChange={v => { setFilterPaese(v); setMapFilterIso(null); }} placeholder={t("map_ph_paese")} options={allPaesi} /></div>
          <div className="mf-size"><FilterSelect value={filterSize} onChange={setFilterSize} placeholder={t("map_ph_size")} options={allSizes} /></div>
          <div className="mf-prod"><FilterSelect value={filterProduttore} onChange={setFilterProduttore} placeholder={t("filter_producers")} options={allProds} /></div>
        </div>
        <div className="chips-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${admin ? 6 : 4}, 1fr)`, gap: 8 }}>
          <button onClick={() => setFilterStato(filterStato === "FULL" ? "" : "FULL")} style={{ ...chipStyle(filterStato === "FULL", "#ffbf00"), width: "100%", justifyContent: "center" }}>{t("chip_full")} {cnt(cFull)}</button>
          <button onClick={() => setFilterStato(filterStato === "EMPTY" ? "" : "EMPTY")} style={{ ...chipStyle(filterStato === "EMPTY", "#4ade80"), width: "100%", justifyContent: "center" }}>{t("chip_empty")} {cnt(cEmpty)}</button>
          <button onClick={() => setPhotoOnly(v => !v)} style={{ ...chipStyle(photoOnly), width: "100%", justifyContent: "center" }}>{t("chip_photo")} {cnt(cPhoto)}</button>
          <button onClick={() => setNoPhoto(v => !v)} style={{ ...chipStyle(noPhoto, "var(--destructive)"), width: "100%", justifyContent: "center" }}>{t("chip_no_photo")} {cnt(cNoPhoto)}</button>
          {admin && <button onClick={() => setValuedOnly(v => !v)} style={{ ...chipStyle(valuedOnly), width: "100%", justifyContent: "center" }}>{t("chip_value")} {cnt(cValued)}</button>}
          {admin && <button onClick={() => setNoValue(v => !v)} style={{ ...chipStyle(noValue, "var(--destructive)"), width: "100%", justifyContent: "center" }}>{t("chip_no_value")} {cnt(cNoValue)}</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <FilterSelect value={sort} onChange={setSort} placeholder={t("sort_ph")} options={getSortOptions(t, admin)} />
          <button onClick={() => { setSearch(""); setFilterPaese(""); setFilterSize(""); setFilterStato(""); setFilterProduttore(""); setPhotoOnly(false); setNoPhoto(false); setValuedOnly(false); setNoValue(false); setSort("default"); setMapFilterIso(null); }}
            style={{ ...mono, fontSize: 11, border: "1px solid transparent", color: "var(--destructive)", padding: "5px 10px", background: "transparent", display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}><X size={12} /> {t("reset")}</button>
          {mapFilterIso && (
            <button onClick={() => setMapFilterIso(null)} style={{ ...mono, fontSize: 10, color: "var(--primary)", background: "var(--primary-dim)", border: "1px solid var(--primary-border)", borderRadius: 6, padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", letterSpacing: "0.05em" }}>
              <img src={`https://flagcdn.com/20x15/${mapFilterIso.toLowerCase()}.png`} alt="" style={{ width: 14, height: 10, borderRadius: 1, objectFit: "cover" }} onError={e => e.target.style.display='none'} />
              {t("map_filtering_by", (lang === "it" ? ISO_TO_NAME_IT[mapFilterIso] : ISO_TO_NAME[mapFilterIso]) || mapFilterIso)}
              <X size={10} />
            </button>
          )}
          <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", marginLeft: "auto", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 12 }}>
            {t("of_total", filteredCans.length, originals.length)}
            <ViewToggle view={view} setView={setView} />
          </div>
        </div>
      </div>

      {/* Griglia lattine */}
      <CanGrid cans={filteredCans} onSelect={can => onSelectCan && onSelectCan(can)} view={view} showValue={admin} />
    </div>
    {refPhotoView && zoomIndex === null && (
      <div onClick={() => setRefPhotoView(null)} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 700 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ ...mono, fontSize: 12, color: "#fff", letterSpacing: "0.1em", textTransform: "uppercase" }}>{t("ref_photos_title", refPhotoView.name)}</div>
            <button onClick={() => setRefPhotoView(null)} style={{ border: "1px solid rgba(255,255,255,0.3)", color: "#fff", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: 6, cursor: "pointer" }}><X size={14} /></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            {refPhotoView.refPhotos.map((url, i) => (
              <img key={i} src={url} alt={`${refPhotoView.name} ${i + 1}`} onClick={() => { setZoomIndex(i); setZoomed(false); }} style={{ width: "100%", borderRadius: 8, border: "1px solid rgba(255,255,255,0.15)", cursor: "pointer" }} />
            ))}
          </div>
        </div>
      </div>
    )}
    {refPhotoView && zoomIndex !== null && (
      <div style={{ position: "fixed", inset: 0, zIndex: 310, background: "#000", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", flexShrink: 0 }}>
          <button onClick={() => { setZoomIndex(null); setZoomed(false); }} style={{ border: "1px solid rgba(255,255,255,0.3)", color: "#fff", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: 6, cursor: "pointer" }}><ChevronLeft size={16} /></button>
          <div style={{ ...mono, fontSize: 11, color: "#fff", letterSpacing: "0.1em" }}>{zoomIndex + 1} / {refPhotoView.refPhotos.length}</div>
          <button onClick={() => { setRefPhotoView(null); setZoomIndex(null); setZoomed(false); }} style={{ border: "1px solid rgba(255,255,255,0.3)", color: "#fff", width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", borderRadius: 6, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {refPhotoView.refPhotos.length > 1 && (
            <button onClick={() => { setZoomIndex(i => (i - 1 + refPhotoView.refPhotos.length) % refPhotoView.refPhotos.length); setZoomed(false); }} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", zIndex: 2, border: "1px solid rgba(255,255,255,0.3)", color: "#fff", width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", borderRadius: "50%", cursor: "pointer" }}><ChevronLeft size={18} /></button>
          )}
          <img
            src={refPhotoView.refPhotos[zoomIndex]}
            alt={`${refPhotoView.name} ${zoomIndex + 1}`}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * 100;
              const y = ((e.clientY - r.top) / r.height) * 100;
              setZoomOrigin(`${x}% ${y}%`);
              setZoomed(z => !z);
            }}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: zoomed ? "zoom-out" : "zoom-in", transform: zoomed ? "scale(2.4)" : "scale(1)", transformOrigin: zoomOrigin, transition: "transform 0.2s ease" }}
          />
          {refPhotoView.refPhotos.length > 1 && (
            <button onClick={() => { setZoomIndex(i => (i + 1) % refPhotoView.refPhotos.length); setZoomed(false); }} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", zIndex: 2, border: "1px solid rgba(255,255,255,0.3)", color: "#fff", width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", borderRadius: "50%", cursor: "pointer" }}><ChevronRight size={18} /></button>
          )}
        </div>
        <div style={{ ...mono, fontSize: 9, color: "rgba(255,255,255,0.5)", textAlign: "center", padding: "10px 0", letterSpacing: "0.1em", textTransform: "uppercase", flexShrink: 0 }}>{t("ref_photos_zoom_hint")}</div>
      </div>
    )}
    </>
  );
}

function MapSVG({ geoData, ownedISOs, missingISOs, partialISOs, countryData, tooltip, setTooltip, onCountryClick }) {
  const { t, lang } = useLang();
  const W = 960, H = 420;
  const ISO3_TO_ISO2 = { "DEU":"DE","GBR":"GB","ITA":"IT","ESP":"ES","PRT":"PT","NLD":"NL","BEL":"BE","AUT":"AT","CHE":"CH","SWE":"SE","DNK":"DK","FIN":"FI","POL":"PL","CZE":"CZ","SVK":"SK","HUN":"HU","ROU":"RO","BGR":"BG","GRC":"GR","TUR":"TR","RUS":"RU","UKR":"UA","JPN":"JP","CHN":"CN","KOR":"KR","AUS":"AU","BRA":"BR","MEX":"MX","CAN":"CA","ARG":"AR","CHL":"CL","ZAF":"ZA","IND":"IN","IRL":"IE","HRV":"HR","SVN":"SI","SRB":"RS","LUX":"LU","MLT":"MT","CYP":"CY","EST":"EE","LVA":"LV","LTU":"LT","BLR":"BY","KAZ":"KZ","ISR":"IL","ARE":"AE","SAU":"SA","EGY":"EG","MAR":"MA","NGA":"NG","KEN":"KE","NZL":"NZ","THA":"TH","VNM":"VN","PHL":"PH","IDN":"ID","MYS":"MY","SGP":"SG","COL":"CO","PER":"PE","ECU":"EC","VEN":"VE","ISL":"IS","MKD":"MK","ALB":"AL","HKG":"HK","TWN":"TW","LKA":"LK","GEO":"GE","JOR":"JO","QAT":"QA","TZA":"TZ","JAM":"JM","MDA":"MD","KHM":"KH","DOM":"DO","CRI":"CR","GTM":"GT","URY":"UY","BOL":"BO","TTO":"TT","AZE":"AZ","AFG":"AF","USA":"US","FRA":"FR","NOR":"NO","PRY":"PY","MNE":"ME","OMN":"OM","BHR":"BH" };
  const NAME_TO_ISO = { "France":"FR","Norway":"NO","Germany":"DE","Italy":"IT","Spain":"ES","Portugal":"PT","United Kingdom":"GB","Netherlands":"NL","Belgium":"BE","Austria":"AT","Switzerland":"CH","Sweden":"SE","Denmark":"DK","Finland":"FI","Poland":"PL","Czech Republic":"CZ","Czechia":"CZ","Hungary":"HU","Romania":"RO","Bulgaria":"BG","Greece":"GR","Turkey":"TR","Türkiye":"TR","Russia":"RU","Russian Federation":"RU","Ukraine":"UA","Japan":"JP","China":"CN","South Korea":"KR","Republic of Korea":"KR","Australia":"AU","Brazil":"BR","Mexico":"MX","Canada":"CA","Argentina":"AR","Chile":"CL","South Africa":"ZA","India":"IN","Ireland":"IE","Croatia":"HR","Slovakia":"SK","Slovenia":"SI","Serbia":"RS","Estonia":"EE","Latvia":"LV","Lithuania":"LT","Belarus":"BY","Kazakhstan":"KZ","Israel":"IL","United Arab Emirates":"AE","Saudi Arabia":"SA","Egypt":"EG","Morocco":"MA","Nigeria":"NG","Kenya":"KE","New Zealand":"NZ","Thailand":"TH","Viet Nam":"VN","Vietnam":"VN","Philippines":"PH","Indonesia":"ID","Malaysia":"MY","Singapore":"SG","Colombia":"CO","Peru":"PE","Ecuador":"EC","Venezuela":"VE","Iceland":"IS","North Macedonia":"MK","Albania":"AL","Taiwan":"TW","Georgia":"GE","Jordan":"JO","Qatar":"QA","Tanzania":"TZ","Jamaica":"JM","Moldova":"MD","Cambodia":"KH","Dominican Republic":"DO","Costa Rica":"CR","Guatemala":"GT","Uruguay":"UY","Bolivia":"BO","Trinidad and Tobago":"TT","Azerbaijan":"AZ","Afghanistan":"AF","United States of America":"US","United States":"US","Paraguay":"PY","Montenegro":"ME","Kosovo":"XK","Oman":"OM","Bahrain":"BH" };

  const getISO = props => {
    const a2 = props["ISO3166-1-Alpha-2"] || props.ISO_A2 || props.iso_a2 || "";
    if (a2 && a2 !== "-99" && a2 !== "-1") return a2.toUpperCase();
    const a3 = props["ISO3166-1-Alpha-3"] || props.ISO_A3 || props.iso_a3 || "";
    if (a3 && ISO3_TO_ISO2[a3.toUpperCase()]) return ISO3_TO_ISO2[a3.toUpperCase()];
    const name = props.name || props.NAME || props.ADMIN || props.SOVEREIGNT || "";
    return NAME_TO_ISO[name] || null;
  };

  const LAT_MAX = 85, LAT_MIN = -60;
  const project = ([lon, lat]) => [(lon + 180) / 360 * W, (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * H];
  const pathFromCoords = coords => coords.map(ring => ring.map((pt, i) => { const [x, y] = project(pt); return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ") + "Z").join(" ");
  const featureToPath = f => { const { type, coordinates } = f.geometry; if (type === "Polygon") return pathFromCoords(coordinates); if (type === "MultiPolygon") return coordinates.map(c => pathFromCoords(c)).join(" "); return ""; };

  // Le coordinate grezze non cambiano mai dopo il caricamento: calcolare le path SVG (potenzialmente
  // migliaia di punti) è costoso, quindi lo si fa una sola volta qui invece che ad ogni render
  // (altrimenti ogni movimento del mouse per il tooltip ricalcolava tutte le 258 path da zero).
  const geoPaths = useMemo(() => geoData.features.map(feature => ({ iso: getISO(feature.properties), d: featureToPath(feature) })).filter(p => p.d), [geoData]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "100%", background: "var(--bg)" }} preserveAspectRatio="xMidYMid meet">
        {geoPaths.map(({ iso, d }, i) => {
          const owned = iso ? ownedISOs.has(iso) : false;
          const missing = iso ? missingISOs.has(iso) : false;
          const partial = iso ? partialISOs.has(iso) : false;
          const count = (iso && countryData[iso]?.count) || 0;
          const fill = partial ? "hsl(48,96%,50%)" : owned ? `hsl(142,70%,${Math.max(28, 52 - count * 2)}%)` : missing ? "hsl(0,72%,38%)" : "hsl(0,0%,10%)";
          const stroke = partial ? "hsl(48,80%,30%)" : owned ? "hsl(142,60%,18%)" : missing ? "hsl(0,60%,25%)" : "hsl(0,0%,18%)";
          const interactive = owned || missing || partial;
          const clickable = owned && count > 0;
          return <path key={i} d={d} fill={fill} stroke={stroke} strokeWidth="0.5"
            onMouseEnter={e => { if (interactive && iso) setTooltip({ iso, count, x: e.clientX, y: e.clientY, cans: countryData[iso]?.cans, missing, partial }); }}
            onMouseMove={e => { if (interactive) setTooltip(p => p ? { ...p, x: e.clientX, y: e.clientY } : p); }}
            onMouseLeave={() => setTooltip(null)}
            onClick={() => { if (clickable) onCountryClick?.(iso); }}
            style={{ cursor: clickable ? "pointer" : interactive ? "default" : "default", transition: "filter 0.1s ease" }} />;
        })}
      </svg>
      {tooltip && (
        <div style={{ position: "fixed", zIndex: 200, pointerEvents: "none", background: "var(--card)", border: "1px solid var(--primary-border)", borderRadius: 8, boxShadow: "var(--shadow)", padding: "8px 12px", ...mono, fontSize: 11, left: Math.min(tooltip.x + 14, window.innerWidth - 200), top: tooltip.y - 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <img src={`https://flagcdn.com/20x15/${tooltip.iso.toLowerCase()}.png`} alt={tooltip.iso} style={{ width: 20, height: 15, borderRadius: 2 }} onError={e => e.target.style.display='none'} />
            <span style={{ color: tooltip.missing ? "var(--destructive)" : tooltip.partial ? "var(--yellow)" : "var(--primary)", fontWeight: 700 }}>{(lang === "it" ? ISO_TO_NAME_IT[tooltip.iso] : ISO_TO_NAME[tooltip.iso]) || tooltip.iso}</span>
          </div>
          <div style={{ color: tooltip.missing ? "var(--destructive)" : tooltip.partial ? "var(--yellow)" : "var(--fg)" }}>
            {tooltip.missing ? t("map_missing") : tooltip.partial ? t("map_partial") : t("map_cans_n", tooltip.count)}
          </div>
          {tooltip.cans?.slice(0, 4).map((c, i) => <div key={i} style={{ color: "var(--muted-fg)", fontSize: 10 }}>{c.nome || c.tipo_linea}</div>)}
          {tooltip.cans?.length > 4 && <div style={{ color: "var(--muted-fg)", fontSize: 10 }}>{t("map_more", tooltip.cans.length - 4)}</div>}
        </div>
      )}
    </div>
  );
}

// ─── SKU parser ──────────────────────────────────────────────────────────────
// Gli SKU possono avere lettere: la "O" è usata come zero (es: "O324B N" = 0324),
// più suffissi di batch/nota (B, C, " N", ...) che vanno ignorati.
// Si prende il PRIMO gruppo di cifre = date code MMYY/MMY.
// Prime 2 cifre = mese (MM). Cifre restanti = anno:
//  - 1 cifra  → 2001-2009  (es: "028"  = mese 02, anno 2008 → feb 2008)
//  - 2+ cifre → 2010+      (es: "0218" = mese 02, anno 2018 → feb 2018)
// Ritorna un intero ordinabile cronologicamente: anno*100 + mese.
function parseSku(sku) {
  if (sku == null || sku === "") return 999999;
  const norm = String(sku).trim().toUpperCase().replace(/O/g, "0"); // O → 0
  const match = norm.match(/\d+/);                                   // primo gruppo di cifre
  if (!match) return 999999;
  let s = match[0];
  if (s.length < 2) return parseInt(s, 10) || 999999;
  // Se le prime 2 cifre danno un mese non valido (>12), manca lo zero iniziale: es "921" → "0921"
  if (parseInt(s.slice(0, 2), 10) > 12) s = "0" + s;
  if (s.length < 3) return parseInt(s, 10) || 999999;
  const mm = parseInt(s.slice(0, 2), 10);
  const yearDigits = s.slice(2);
  const year = yearDigits.length === 1
    ? 2000 + parseInt(yearDigits, 10)            // 1 cifra → 2001-2009
    : 2000 + parseInt(yearDigits.slice(-2), 10); // 2 cifre → 2010+
  return year * 100 + (mm || 0);
}

// ─── Main App ─────────────────────────────────────────────────────────────────
const DEFAULT_FILTERS = { search: "", tipo: "", size: "", produttore: "", piena_vuota: "", apertura: "", sort: "default", photoOnly: false, noPhoto: false, valuedOnly: false, noValue: false, nazione: "" };

// Filtri "a cascata": applica tutti i filtri attivi TRANNE quelli in skipKeys.
// Usata per calcolare le opzioni di ogni singolo filtro (tendine, chip) in base
// a cosa resterebbe selezionando TUTTI GLI ALTRI filtri già attivi — così, ad
// es., cercando "vr46" nella ricerca testuale, la tendina Nazione mostra solo
// le nazioni disponibili tra le lattine che matchano "vr46", non tutte quelle
// dell'intera collezione.
function filterCansExcept(cans, filters, skipKeys) {
  const skip = new Set(skipKeys);
  let r = cans;
  if (!skip.has("tipo") && filters.tipo) r = r.filter(c => c.tipo_linea === filters.tipo);
  if (!skip.has("size") && filters.size) r = r.filter(c => c.size === filters.size);
  if (!skip.has("produttore") && filters.produttore) r = r.filter(c => c.produttore === filters.produttore);
  if (!skip.has("piena_vuota") && filters.piena_vuota) r = r.filter(c => c.piena_vuota === filters.piena_vuota);
  if (!skip.has("apertura") && filters.apertura) r = r.filter(c => c.apertura === filters.apertura);
  if (!skip.has("photoOnly") && filters.photoOnly) r = r.filter(c => c.photos?.some(p => p));
  if (!skip.has("noPhoto") && filters.noPhoto) r = r.filter(c => !c.photos?.some(p => p));
  if (!skip.has("valuedOnly") && filters.valuedOnly) r = r.filter(c => parseValore(c.valore) > 0);
  if (!skip.has("noValue") && filters.noValue) r = r.filter(c => !(parseValore(c.valore) > 0));
  if (!skip.has("nazione") && filters.nazione) r = r.filter(c => c.lingua === filters.nazione);
  if (!skip.has("search") && filters.search) { const s = filters.search.toLowerCase(); r = r.filter(c => (c.nome + " " + c.sku + " " + c.tipo_linea).toLowerCase().includes(s)); }
  return r;
}

// ─── Filtri <-> URL (condividi vista) ───────────────────────────────────────────
const FILTER_STR_KEYS = ["search", "tipo", "size", "produttore", "piena_vuota", "apertura", "sort", "nazione"];
function filtersToQuery(f) {
  const p = new URLSearchParams();
  FILTER_STR_KEYS.forEach(k => { if (f[k] && f[k] !== "default") p.set(k, f[k]); });
  if (f.photoOnly) p.set("photo", "1");
  if (f.noPhoto) p.set("nophoto", "1");
  if (f.valuedOnly) p.set("valued", "1");
  if (f.noValue) p.set("novalue", "1");
  return p.toString();
}
function filtersFromQuery() {
  const p = new URLSearchParams(window.location.search); const f = {};
  FILTER_STR_KEYS.forEach(k => { const v = p.get(k); if (v) f[k] = v; });
  if (p.get("photo")) f.photoOnly = true;
  if (p.get("nophoto")) f.noPhoto = true;
  if (p.get("valued")) f.valuedOnly = true;
  if (p.get("novalue")) f.noValue = true;
  return f;
}
// ─── Viste salvate (localStorage) ───────────────────────────────────────────────
function loadViews() { try { return JSON.parse(localStorage.getItem("vault_views") || "[]"); } catch { return []; } }
function persistViews(v) { localStorage.setItem("vault_views", JSON.stringify(v)); }

// ─── Doppioni Page ────────────────────────────────────────────────────────────
// Le lattine qui sono documenti "cans" con is_duplicate:true: restano nella stessa
// collezione Firestore, ma vengono escluse ovunque da Vault, Stats e OG MAP.
function DuplicatesPage({ duplicates, setAllCans, page, setPage, admin, user, onLogout, onToggleAdmin, loginBusy, onShowRules, onSetPassword, onMigratePrices, migratingPrices, onUppercaseData, uppercasingData }) {
  const { t } = useLang();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [detailCan, setDetailCan] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editCan, setEditCan] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useVaultView();

  const filtered = useMemo(() => {
    let r = [...duplicates];
    if (filters.tipo) r = r.filter(c => c.tipo_linea === filters.tipo);
    if (filters.size) r = r.filter(c => c.size === filters.size);
    if (filters.produttore) r = r.filter(c => c.produttore === filters.produttore);
    if (filters.piena_vuota) r = r.filter(c => c.piena_vuota === filters.piena_vuota);
    if (filters.apertura) r = r.filter(c => c.apertura === filters.apertura);
    if (filters.photoOnly) r = r.filter(c => c.photos?.some(p => p));
    if (filters.noPhoto) r = r.filter(c => !c.photos?.some(p => p));
    if (filters.valuedOnly) r = r.filter(c => parseValore(c.valore) > 0);
    if (filters.noValue) r = r.filter(c => !(parseValore(c.valore) > 0));
    if (filters.nazione) r = r.filter(c => c.lingua === filters.nazione);
    if (filters.search) { const s = filters.search.toLowerCase(); r = r.filter(c => (c.nome + " " + c.sku + " " + c.tipo_linea).toLowerCase().includes(s)); }
    if (filters.sort === "name_az") r.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    else if (filters.sort === "name_za") r.sort((a, b) => (b.nome || "").localeCompare(a.nome || ""));
    else if (filters.sort === "sku_asc") r.sort((a, b) => parseSku(a.sku) - parseSku(b.sku));
    else if (filters.sort === "sku_desc") r.sort((a, b) => parseSku(b.sku) - parseSku(a.sku));
    else if (filters.sort === "tipo") r.sort((a, b) => (a.tipo_linea || "").localeCompare(b.tipo_linea || ""));
    else if (filters.sort === "valore_desc") r.sort((a, b) => parseValore(b.valore) - parseValore(a.valore));
    else if (filters.sort === "valore_asc") r.sort((a, b) => parseValore(a.valore) - parseValore(b.valore));
    else if (filters.sort === "recent") r.sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
    return r;
  }, [duplicates, filters]);

  const currentIndex = detailCan ? filtered.findIndex(c => c.id === detailCan.id) : -1;

  const handleSave = async (formData) => {
    try {
      if (editCan) {
        await fbUpdateCan(editCan.id, formData);
        setAllCans(prev => prev.map(c => c.id === editCan.id ? { ...c, ...formData } : c));
        toast.success(t("toast_can_updated"));
      } else {
        const created = await fbAddCan({ ...formData, is_duplicate: true });
        setAllCans(prev => [created, ...prev]);
        toast.success(t("toast_can_added"));
      }
      setEditOpen(false);
    } catch (e) { toast.error(t("toast_save_err", e.message)); }
  };

  const handleDelete = async () => {
    if (!detailCan) return;
    try {
      await fbDeleteCan(detailCan.id);
      setAllCans(prev => prev.filter(c => c.id !== detailCan.id));
      setDetailOpen(false); toast.success(t("toast_can_deleted"));
    } catch (e) { toast.error(t("toast_delete_err", e.message)); }
  };

  const handleExport = async () => {
    try {
      const XLSX = await loadXLSX();
      const data = duplicates.map(c => ({ "TIPO LINEA": c.tipo_linea, "NOME": c.nome, "SKU": c.sku, "PRODUTTORE": c.produttore, "SIZE": c.size, "LINGUA": c.lingua, "TOP/TAB": c.top_tab, "PIENA/VUOTA": c.piena_vuota, "APERTURA": c.apertura, "VALORE": c.valore ?? "" }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "IN VENDITA");
      XLSX.writeFile(wb, "monster_vault_for_sale_export.xlsx");
      toast.success(t("toast_export_done"));
    } catch { toast.error(t("toast_export_err")); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 80 }}>
      <AppHeader page={page} setPage={setPage}
        admin={admin} user={user} onLogout={onLogout} onToggleAdmin={onToggleAdmin} loginBusy={loginBusy} onShowRules={onShowRules} onSetPassword={onSetPassword} onMigratePrices={onMigratePrices} migratingPrices={migratingPrices} onUppercaseData={onUppercaseData} uppercasingData={uppercasingData}
        onAdd={admin ? () => { setEditCan(null); setEditOpen(true); } : undefined}
        onImport={admin ? () => setImportOpen(true) : undefined}
        onExport={admin ? handleExport : undefined} />
      <FiltersBar cans={duplicates} filters={filters} setFilters={setFilters} filteredCount={filtered.length} view={view} setView={setView} />
      <CanGrid cans={filtered} onSelect={can => { setDetailCan(can); setDetailOpen(true); }} emptyLabel={t("empty_duplicates")} view={view} />
      <DetailModal can={detailCan} open={detailOpen} onClose={() => setDetailOpen(false)}
        onEdit={admin ? () => { setEditCan(detailCan); setEditOpen(true); setDetailOpen(false); } : null}
        onDelete={admin ? handleDelete : null}
        onPrev={currentIndex > 0 ? () => setDetailCan(filtered[currentIndex - 1]) : null}
        onNext={currentIndex < filtered.length - 1 ? () => setDetailCan(filtered[currentIndex + 1]) : null} />
      {admin && <EditModal can={editCan} open={editOpen} onClose={() => setEditOpen(false)} onSave={handleSave} allCans={duplicates} />}
      {admin && <ImportModal open={importOpen} onClose={() => setImportOpen(false)} existingCans={duplicates} isDuplicate
        onImportDone={newCans => { setAllCans(prev => [...newCans, ...prev]); setImportOpen(false); }} />}
    </div>
  );
}

// ─── Wishlist Page ──────────────────────────────────────────────────────────────
// I "set" sono documenti "cans" con is_set:true (stessa collezione Firestore, così
// niente regole di sicurezza da toccare). Ogni set ha set_name + set_items: [{id,
// label, can_id}]. can_id, se valorizzato e ancora presente in "cans", rende lo
// slot "posseduto"; altrimenti lo slot è "mancante" e va evidenziato in rosso.
// I set sono componibili a mano dall'utente: nessun set precaricato.
function LinkCanPicker({ cans, lang, onSelect, onClose }) {
  const { t } = useLang();
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  const [rect, setRect] = useState(null);
  useEffect(() => {
    const update = () => { if (inputRef.current) setRect(inputRef.current.getBoundingClientRect()); };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = !s ? cans : cans.filter(c => `${c.nome || ""} ${c.sku || ""} ${countryName(c.lingua, lang) || ""}`.toLowerCase().includes(s));
    return list.slice(0, 40);
  }, [q, cans, lang]);
  return (
    <div style={{ position: "relative" }}>
      <input ref={inputRef} type="text" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t("wishlist_link_ph")}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}
        style={{ ...mono, fontSize: 9, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "4px 6px", width: "100%" }} />
      {rect && createPortal(
        <>
          <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 140 }} />
          <div style={{ position: "fixed", top: rect.bottom + 2, left: rect.left, width: rect.width, zIndex: 150, background: "var(--card)", border: "1px solid var(--border)", maxHeight: 220, overflowY: "auto", overflowX: "auto", boxShadow: "var(--shadow)" }}>
            {results.length === 0 && <div style={{ padding: 8, ...mono, fontSize: 10, color: "var(--muted-fg)" }}>—</div>}
            {results.map(c => (
              <button key={c.id} onClick={() => onSelect(c.id)} style={{ width: "max-content", minWidth: "100%", boxSizing: "border-box", textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer" }}>
                <Flag lingua={c.lingua} />
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--fg)" }}>{c.nome || "—"}</span>
                  <span style={{ ...mono, fontSize: 9, color: "var(--muted-fg)" }}>{c.sku || "—"} · {countryName(c.lingua, lang) || "—"}</span>
                </div>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function SetSlotTile({ item, ownedCan, lang, onRemove, onLink, onUnlink, cans, readOnly }) {
  const { t } = useLang();
  const [linking, setLinking] = useState(false);
  const [imgError, setImgError] = useState(false);
  if (ownedCan) {
    const firstPhoto = ownedCan.photos?.find(p => p) || "";
    return (
      <div style={{ position: "relative", background: "var(--card)", border: "1px solid var(--primary-border)", overflow: "hidden" }}>
        <div style={{ width: "100%", paddingTop: "100%", position: "relative", background: "var(--bg)" }}>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {firstPhoto && !imgError ? <img src={cldThumb(firstPhoto, 300)} alt="" onError={() => setImgError(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ ...orbitron, fontSize: 36, color: "var(--primary)", opacity: 0.18 }}>M</span>}
          </div>
          <span style={{ position: "absolute", top: 4, left: 4, maxWidth: "calc(100% - 28px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...mono, fontSize: 8, background: "rgba(0,0,0,0.85)", border: "1px solid var(--primary-border)", color: "var(--primary)", padding: "2px 5px", letterSpacing: "0.06em" }}>{t("wishlist_owned_tag")}</span>
          {!readOnly && <button onClick={onRemove} title={t("wishlist_remove_slot")} style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, background: "rgba(0,0,0,0.8)", color: "var(--destructive)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={11} /></button>}
          {!readOnly && <button onClick={onUnlink} title={t("wishlist_unlink")} style={{ position: "absolute", bottom: 4, right: 4, width: 18, height: 18, background: "rgba(0,0,0,0.8)", color: "var(--muted-fg)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><Link2 size={10} /></button>}
        </div>
        <div style={{ padding: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--fg)", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ownedCan.nome || "—"}</div>
          {ownedCan.sku && <div style={{ ...mono, fontSize: 9, color: "var(--primary)" }}>{ownedCan.sku}</div>}
          {ownedCan.lingua && <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}><Flag lingua={ownedCan.lingua} /><span style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{countryName(ownedCan.lingua, lang)}</span></div>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ position: "relative", background: "rgba(239,68,68,0.06)", border: "1px dashed var(--destructive)", overflow: "hidden" }}>
      <div style={{ width: "100%", paddingTop: "100%", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 8, gap: 6 }}>
          <AlertTriangle size={22} style={{ color: "var(--destructive)", opacity: 0.8 }} />
          <div style={{ ...mono, fontSize: 10, color: "var(--destructive)", textAlign: "center", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>{item.label}</div>
        </div>
        <span style={{ position: "absolute", top: 4, left: 4, maxWidth: "calc(100% - 28px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...mono, fontSize: 8, background: "rgba(0,0,0,0.85)", border: "1px solid var(--destructive)", color: "var(--destructive)", padding: "2px 5px", letterSpacing: "0.06em" }}>{t("wishlist_missing_tag")}</span>
        {!readOnly && <button onClick={onRemove} title={t("wishlist_remove_slot")} style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, background: "rgba(0,0,0,0.8)", color: "var(--destructive)", border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}><X size={11} /></button>}
      </div>
      <div style={{ padding: 6 }}>
        {item.iso && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <img src={`https://flagcdn.com/20x15/${wishlistFlagIso(item.iso).toLowerCase()}.png`} alt="" style={{ width: 14, height: 10, borderRadius: 2, objectFit: "cover", flexShrink: 0 }} onError={e => e.target.style.display = 'none'} />
            <span style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wishlistCountryName(item.iso, lang)}</span>
          </div>
        )}
        {!readOnly && (linking ? (
          <LinkCanPicker cans={cans} lang={lang} onClose={() => setLinking(false)} onSelect={id => { onLink(id); setLinking(false); }} />
        ) : (
          <button onClick={() => setLinking(true)} style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", background: "transparent", border: "1px solid var(--border)", padding: "4px 6px", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer" }}><Link2 size={10} />{t("wishlist_owned_tag")}?</button>
        ))}
      </div>
    </div>
  );
}

const COUNTRY_ISO_LIST = Object.keys(ISO_TO_NAME);
// Regioni/sotto-paesi senza codice ISO proprio ma con design lattina distinto
// (es. la legge dello Utah impone una grafica diversa dal resto degli USA).
const SPECIAL_COUNTRIES = [{ iso: "US-UT", flagIso: "US", name_it: "USA (Utah)", name_en: "USA (Utah)" }];
function wishlistCountryName(iso, lang) {
  const special = SPECIAL_COUNTRIES.find(s => s.iso === iso);
  if (special) return (lang === "it" ? special.name_it : special.name_en).toUpperCase();
  return ((lang === "it" ? ISO_TO_NAME_IT[iso] : ISO_TO_NAME[iso]) || iso).toUpperCase();
}
function wishlistFlagIso(iso) {
  return SPECIAL_COUNTRIES.find(s => s.iso === iso)?.flagIso || iso;
}

function SetCard({ setDoc, cans, onDelete, onUpdateItems, onRename, readOnly }) {
  const { t, lang } = useLang();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [slotLabel, setSlotLabel] = useState("");
  const [slotIso, setSlotIso] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(setDoc.set_name);
  const items = setDoc.set_items || [];
  const canById = id => cans.find(c => c.id === id);
  const ownedCount = items.filter(it => it.can_id && canById(it.can_id)).length;
  const dragIndexRef = useRef(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const commitRename = () => {
    const v = renameVal.trim();
    if (v && v !== setDoc.set_name) onRename(v);
    setRenaming(false);
  };

  const countryOptions = useMemo(() => {
    const base = COUNTRY_ISO_LIST.map(iso => ({ iso, name: wishlistCountryName(iso, lang) }));
    const specials = SPECIAL_COUNTRIES.map(s => ({ iso: s.iso, name: wishlistCountryName(s.iso, lang) }));
    return [...base, ...specials].sort((a, b) => a.name.localeCompare(b.name));
  }, [lang]);

  const handleDeleteClick = () => {
    if (!confirmDelete) { setConfirmDelete(true); setTimeout(() => setConfirmDelete(false), 3000); return; }
    onDelete();
  };

  const addSlot = () => {
    if (!slotLabel.trim()) return;
    onUpdateItems([...items, { id: Date.now().toString(36), label: slotLabel.trim(), can_id: null, iso: slotIso || null }]);
    setSlotLabel(""); setSlotIso("");
  };
  const removeSlot = (id) => onUpdateItems(items.filter(it => it.id !== id));
  const linkSlot = (id, can_id) => onUpdateItems(items.map(it => it.id === id ? { ...it, can_id } : it));

  const reorder = (from, to) => {
    if (from == null || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onUpdateItems(next);
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", cursor: renaming ? "default" : "pointer" }} onClick={() => !renaming && setExpanded(v => !v)}>
        {expanded ? <ChevronUp size={14} style={{ color: "var(--muted-fg)", flexShrink: 0 }} /> : <ChevronDown size={14} style={{ color: "var(--muted-fg)", flexShrink: 0 }} />}
        {renaming ? (
          <input autoFocus type="text" value={renameVal} onChange={e => setRenameVal(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") { setRenameVal(setDoc.set_name); setRenaming(false); } }}
            onBlur={commitRename}
            style={{ ...orbitron, fontSize: 14, color: "var(--fg-strong)", textTransform: "uppercase", flex: 1, background: "var(--muted)", border: "1px solid var(--primary-border)", padding: "4px 8px" }} />
        ) : (
          <div style={{ ...orbitron, fontSize: 14, color: "var(--fg-strong)", flex: 1, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{setDoc.set_name}</div>
        )}
        {!renaming && !readOnly && (
          <button onClick={e => { e.stopPropagation(); setRenameVal(setDoc.set_name); setRenaming(true); }} title={t("wishlist_rename")} style={{ border: "none", background: "transparent", color: "var(--muted-fg)", padding: 4, display: "flex", flexShrink: 0, cursor: "pointer" }}><Pencil size={12} /></button>
        )}
        <div style={{ ...mono, fontSize: 11, color: ownedCount === items.length && items.length > 0 ? "var(--primary)" : "var(--muted-fg)", whiteSpace: "nowrap" }}>{t("wishlist_progress", ownedCount, items.length)}</div>
        {!readOnly && (
          <button onClick={e => { e.stopPropagation(); handleDeleteClick(); }} style={{ ...mono, fontSize: 10, border: "1px solid transparent", color: "var(--destructive)", padding: "4px 8px", background: confirmDelete ? "rgba(239,68,68,0.15)" : "transparent", display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <Trash2 size={12} />{confirmDelete && <span className="btn-label">{t("wishlist_confirm_delete_set")}</span>}
          </button>
        )}
      </div>
      <div style={{ height: 3, background: "var(--border)", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, width: `${items.length ? (ownedCount / items.length * 100) : 0}%`, background: "var(--primary)", transition: "width 0.3s ease" }} />
      </div>
      {expanded && (
        <div style={{ padding: "0 16px 16px" }}>
          {items.length === 0 ? (
            <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", padding: "12px 0" }}>{t("wishlist_no_slots")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10, marginBottom: 12 }}>
              {items.map((item, idx) => (
                <div key={item.id} draggable={!readOnly}
                  onDragStart={e => { if (readOnly || e.target.closest("button, input, select, a")) { e.preventDefault(); return; } dragIndexRef.current = idx; e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={e => { if (readOnly) return; e.preventDefault(); if (dragOverIdx !== idx) setDragOverIdx(idx); }}
                  onDragLeave={() => setDragOverIdx(v => v === idx ? null : v)}
                  onDrop={e => { if (readOnly) return; e.preventDefault(); reorder(dragIndexRef.current, idx); dragIndexRef.current = null; setDragOverIdx(null); }}
                  onDragEnd={() => { dragIndexRef.current = null; setDragOverIdx(null); }}
                  style={{ position: "relative", cursor: readOnly ? "default" : "grab", opacity: dragIndexRef.current === idx ? 0.4 : 1, outline: dragOverIdx === idx ? "2px solid var(--primary)" : "none", outlineOffset: 2 }}>
                  {!readOnly && <div style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", zIndex: 2, color: "rgba(255,255,255,0.5)", pointerEvents: "none" }}><GripVertical size={12} /></div>}
                  <SetSlotTile item={item} ownedCan={item.can_id ? canById(item.can_id) : null} lang={lang} readOnly={readOnly}
                    onRemove={() => removeSlot(item.id)} onLink={can_id => linkSlot(item.id, can_id)} onUnlink={() => linkSlot(item.id, null)} cans={cans} />
                </div>
              ))}
            </div>
          )}
          {!readOnly && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input type="text" value={slotLabel} onChange={e => setSlotLabel(e.target.value)} placeholder={t("wishlist_slot_label_ph")}
                onKeyDown={e => { if (e.key === "Enter") addSlot(); }}
                style={{ ...mono, fontSize: 11, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "7px 10px", flex: 2, minWidth: 140 }} />
              <select value={slotIso} onChange={e => setSlotIso(e.target.value)}
                style={{ ...mono, fontSize: 11, background: "var(--muted)", border: "1px solid var(--border)", color: slotIso ? "var(--fg)" : "var(--muted-fg)", padding: "7px 10px", flex: 1, minWidth: 120 }}>
                <option value="">{t("wishlist_country_ph")}</option>
                {countryOptions.map(c => <option key={c.iso} value={c.iso}>{c.name}</option>)}
              </select>
              <Btn onClick={addSlot} variant="primary"><Plus size={12} /><span className="btn-label">{t("wishlist_add_slot")}</span></Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WishlistPage({ sets, cans, setAllCans, page, setPage, admin, user, onLogout, onToggleAdmin, loginBusy, onShowRules, onSetPassword, onMigratePrices, migratingPrices, onUppercaseData, uppercasingData }) {
  const { t } = useLang();
  const [newSetName, setNewSetName] = useState("");

  const createSet = async () => {
    if (!newSetName.trim()) { toast.error(t("wishlist_name_required")); return; }
    try {
      const created = await fbAddCan({ is_set: true, set_name: newSetName.trim(), set_items: [] });
      setAllCans(prev => [created, ...prev]);
      setNewSetName("");
      toast.success(t("wishlist_set_created"));
    } catch (e) { toast.error(t("toast_save_err", e.message)); }
  };

  const deleteSet = async (id) => {
    try {
      await fbDeleteCan(id);
      setAllCans(prev => prev.filter(c => c.id !== id));
    } catch (e) { toast.error(t("toast_delete_err", e.message)); }
  };

  const updateSetItems = async (setDoc, items) => {
    setAllCans(prev => prev.map(c => c.id === setDoc.id ? { ...c, set_items: items } : c));
    try { await fbUpdateCan(setDoc.id, { set_items: items }); }
    catch (e) { toast.error(t("toast_save_err", e.message)); }
  };

  const renameSet = async (setDoc, name) => {
    setAllCans(prev => prev.map(c => c.id === setDoc.id ? { ...c, set_name: name } : c));
    try { await fbUpdateCan(setDoc.id, { set_name: name }); }
    catch (e) { toast.error(t("toast_save_err", e.message)); }
  };

  const totalItems = useMemo(() => sets.reduce((s, d) => s + (d.set_items?.length || 0), 0), [sets]);
  const totalOwned = useMemo(() => sets.reduce((s, d) => s + (d.set_items || []).filter(it => it.can_id && cans.some(c => c.id === it.can_id)).length, 0), [sets, cans]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 80 }}>
      <AppHeader page={page} setPage={setPage} admin={admin} user={user} onLogout={onLogout} onToggleAdmin={onToggleAdmin} loginBusy={loginBusy} onShowRules={onShowRules} onSetPassword={onSetPassword} onMigratePrices={onMigratePrices} migratingPrices={migratingPrices} onUppercaseData={onUppercaseData} uppercasingData={uppercasingData} />
      <div style={{ padding: 16 }}>
        {admin && (
          <div style={{ display: "flex", gap: 8, marginBottom: sets.length ? 6 : 20 }}>
            <input type="text" value={newSetName} onChange={e => setNewSetName(e.target.value)} placeholder={t("wishlist_new_set_ph")}
              onKeyDown={e => { if (e.key === "Enter") createSet(); }}
              style={{ ...mono, fontSize: 12, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "9px 12px", flex: 1 }} />
            <Btn onClick={createSet} variant="primary"><Plus size={13} /><span className="btn-label">{t("wishlist_create_set")}</span></Btn>
          </div>
        )}
        {sets.length > 0 && <div style={{ ...mono, fontSize: 10, color: "var(--muted-fg)", marginBottom: 14, letterSpacing: "0.05em" }}>{t("wishlist_summary", sets.length, totalOwned, totalItems)}</div>}
        {sets.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px" }}>
            <Heart size={48} style={{ color: "var(--border)", marginBottom: 16 }} />
            <div style={{ ...mono, color: "var(--muted-fg)", textAlign: "center" }}>{t("wishlist_empty")}</div>
          </div>
        ) : (
          sets.map(setDoc => (
            <SetCard key={setDoc.id} setDoc={setDoc} cans={cans} onDelete={() => deleteSet(setDoc.id)} onUpdateItems={items => updateSetItems(setDoc, items)} onRename={name => renameSet(setDoc, name)} readOnly={!admin} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Cookie banner + regole del sito (mostrati una volta sola, salvati in localStorage) ─
function CookieBanner({ onAccept }) {
  const { t } = useLang();
  return (
    <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 300, background: "var(--secondary)", borderTop: "1px solid var(--primary-border)", padding: "14px 16px", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", boxShadow: "0 -4px 20px rgba(0,0,0,0.3)" }}>
      <Cookie size={18} style={{ color: "var(--muted-fg)", flexShrink: 0 }} />
      <div style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", lineHeight: 1.6, flex: 1, minWidth: 220 }}>{t("cookie_text")}</div>
      <LangToggle />
      <Btn onClick={onAccept} variant="primary" style={{ flexShrink: 0 }}>{t("cookie_accept")}</Btn>
    </div>
  );
}

function RulesModal({ onClose }) {
  const { t } = useLang();
  return (
    <div className="fade-in" style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="modal-in" style={{ background: "var(--secondary)", border: "1px solid var(--primary-border)", borderRadius: 14, width: "100%", maxWidth: 560, maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "var(--shadow)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--primary-border)", flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, border: "1px solid var(--primary-border)", background: "var(--primary-dim, rgba(0,255,65,0.08))", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Lock size={14} style={{ color: "var(--primary)" }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ ...mono, fontSize: 9, letterSpacing: "0.15em", color: "var(--muted-fg)", marginBottom: 2 }}>{t("rules_kicker")}</div>
            <div style={{ ...orbitron, fontSize: 14, color: "var(--primary)", textTransform: "uppercase" }}>{t("rules_title")}</div>
          </div>
          <LangToggle />
          <button onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", flexShrink: 0 }}><X size={13} /></button>
        </div>
        <div className="no-scrollbar" style={{ overflow: "auto", flex: 1, padding: 18 }}>
          <p style={{ ...mono, fontSize: 12, color: "var(--fg)", lineHeight: 1.7, marginBottom: 20 }}>{t("rules_intro")}</p>

          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.15em", color: "var(--primary)", marginBottom: 10 }}>{t("rules_section_view")}</div>
          <ul style={{ margin: "0 0 20px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            {["rules_view_1", "rules_view_2", "rules_view_3", "rules_view_4", "rules_view_5"].map(k => (
              <li key={k} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--fg)", lineHeight: 1.6 }}>
                <Check size={13} style={{ color: "var(--primary)", flexShrink: 0, marginTop: 2 }} />{t(k)}
              </li>
            ))}
          </ul>

          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.15em", color: "var(--destructive)", marginBottom: 10 }}>{t("rules_section_hidden")}</div>
          <ul style={{ margin: "0 0 20px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            <li style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--fg)", lineHeight: 1.6 }}><X size={13} style={{ color: "var(--destructive)", flexShrink: 0, marginTop: 2 }} />{t("rules_hidden_1")}</li>
          </ul>

          <div style={{ ...mono, fontSize: 10, letterSpacing: "0.15em", color: "var(--muted-fg)", marginBottom: 10 }}>{t("rules_section_locked")}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
            {["rules_locked_1", "rules_locked_2"].map(k => (
              <li key={k} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--muted-fg)", lineHeight: 1.6 }}>
                <Lock size={12} style={{ flexShrink: 0, marginTop: 2 }} />{t(k)}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <Btn onClick={onClose} variant="primary" style={{ width: "100%", justifyContent: "center" }}>{t("rules_close")}</Btn>
        </div>
      </div>
    </div>
  );
}

function EmailLoginModal({ onClose, onSubmit, loginBusy }) {
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const submit = e => { e.preventDefault(); if (password) onSubmit(password); };
  return (
    <div className="fade-in" style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <form onSubmit={submit} className="modal-in" style={{ background: "var(--secondary)", border: "1px solid var(--primary-border)", borderRadius: 14, width: "100%", maxWidth: 340, overflow: "hidden", boxShadow: "var(--shadow)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--primary-border)" }}>
          <Lock size={14} style={{ color: "var(--primary)", flexShrink: 0 }} />
          <div style={{ flex: 1, ...orbitron, fontSize: 13, color: "var(--primary)", textTransform: "uppercase" }}>{t("email_login_title")}</div>
          <button type="button" onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><X size={12} /></button>
        </div>
        <div style={{ padding: 18 }}>
          <p style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", lineHeight: 1.6, marginBottom: 14 }}>{t("email_login_desc")}</p>
          <input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder={t("email_login_password_ph")} style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "10px 12px", width: "100%" }} />
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <Btn type="button" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>{t("email_login_cancel")}</Btn>
          <Btn type="submit" variant="primary" disabled={loginBusy || !password} style={{ flex: 1, justifyContent: "center" }}>{loginBusy ? <Spinner size={12} /> : t("email_login_submit")}</Btn>
        </div>
      </form>
    </div>
  );
}

function SetPasswordModal({ onClose, onSubmit, loginBusy }) {
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && password !== confirm;
  const submit = e => { e.preventDefault(); if (password && password === confirm) onSubmit(password); };
  return (
    <div className="fade-in" style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <form onSubmit={submit} className="modal-in" style={{ background: "var(--secondary)", border: "1px solid var(--primary-border)", borderRadius: 14, width: "100%", maxWidth: 340, overflow: "hidden", boxShadow: "var(--shadow)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--primary-border)" }}>
          <Lock size={14} style={{ color: "var(--primary)", flexShrink: 0 }} />
          <div style={{ flex: 1, ...orbitron, fontSize: 13, color: "var(--primary)", textTransform: "uppercase" }}>{t("set_password_title")}</div>
          <button type="button" onClick={onClose} style={{ border: "1px solid var(--border)", color: "var(--muted-fg)", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><X size={12} /></button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", lineHeight: 1.6, marginBottom: 4 }}>{t("set_password_desc")}</p>
          <input type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)} placeholder={t("set_password_new_ph")} style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid var(--border)", color: "var(--fg)", padding: "10px 12px", width: "100%" }} />
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={t("set_password_confirm_ph")} style={{ ...mono, fontSize: 13, background: "var(--muted)", border: "1px solid", borderColor: mismatch ? "var(--destructive)" : "var(--border)", color: "var(--fg)", padding: "10px 12px", width: "100%" }} />
          {mismatch && <div style={{ ...mono, fontSize: 10, color: "var(--destructive)" }}>{t("set_password_mismatch")}</div>}
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <Btn type="button" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>{t("email_login_cancel")}</Btn>
          <Btn type="submit" variant="primary" disabled={loginBusy || !password || password !== confirm} style={{ flex: 1, justifyContent: "center" }}>{loginBusy ? <Spinner size={12} /> : t("set_password_submit")}</Btn>
        </div>
      </form>
    </div>
  );
}

// ─── Chrome condiviso da ogni pagina: cookie banner, popup regole, toast ────────
function SiteChrome({ rulesOpen, onCloseRules, cookiesAccepted, onAcceptCookies, emailLoginOpen, onCloseEmailLogin, onEmailLogin, setPasswordOpen, onCloseSetPassword, onSetPassword, loginBusy }) {
  return (
    <>
      {!cookiesAccepted && <CookieBanner onAccept={onAcceptCookies} />}
      {rulesOpen && cookiesAccepted && <RulesModal onClose={onCloseRules} />}
      {emailLoginOpen && <EmailLoginModal onClose={onCloseEmailLogin} onSubmit={onEmailLogin} loginBusy={loginBusy} />}
      {setPasswordOpen && <SetPasswordModal onClose={onCloseSetPassword} onSubmit={onSetPassword} loginBusy={loginBusy} />}
      <Toaster />
    </>
  );
}

export default function App() {
  return <LangProvider><AppInner /></LangProvider>;
}

function AppInner() {
  const { t, lang } = useLang();
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [allCans, setAllCans] = useState([]);
  const cans = useMemo(() => allCans.filter(c => !c.is_duplicate && !c.is_set), [allCans]);
  const duplicates = useMemo(() => allCans.filter(c => c.is_duplicate), [allCans]);
  const sets = useMemo(() => allCans.filter(c => c.is_set), [allCans]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_FILTERS, ...filtersFromQuery() }));
  const [page, setPage] = useState("vault");
  const [detailCan, setDetailCan] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editCan, setEditCan] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [view, setView] = useVaultView();
  const admin = !!user && ADMIN_EMAILS.includes(user.email);
  useEffect(() => { document.documentElement.setAttribute("data-theme", localStorage.getItem("vault_theme") || "dark"); }, []);
  const [entered, setEntered] = useState(() => sessionStorage.getItem("vault_entered") === "1");
  const [loginBusy, setLoginBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const handleCloseRules = () => { localStorage.setItem("vault_rules_seen", "1"); setRulesOpen(false); };
  const [cookiesAccepted, setCookiesAccepted] = useState(() => localStorage.getItem("vault_cookies_accepted") === "1");
  const handleAcceptCookies = () => { localStorage.setItem("vault_cookies_accepted", "1"); setCookiesAccepted(true); };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // Prima i cookie, poi le regole: mai insieme. Le regole si aprono solo dopo che il
  // banner cookie è stato chiuso (o subito, se i cookie erano già stati accettati).
  useEffect(() => {
    if (cookiesAccepted && localStorage.getItem("vault_rules_seen") !== "1") setRulesOpen(true);
  }, [cookiesAccepted]);

  // Su iOS, il login con Google in popup/redirect non è affidabile quando il sito è
  // aperto come web app da schermata Home (iOS a volte apre Safari a parte e la web
  // app resta sospesa senza accorgersi del nuovo accesso). In quel caso usiamo email
  // + password: nessuna navigazione esterna, quindi nessuno di questi problemi.
  const isStandaloneApp = () => window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const [emailLoginOpen, setEmailLoginOpen] = useState(false);

  const handleLogin = async () => {
    if (isStandaloneApp()) { setEmailLoginOpen(true); return; }
    setLoginBusy(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, googleProvider);
      toast.success(t("toast_login_ok"));
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast.error(t("toast_login_err", e.message));
    } finally { setLoginBusy(false); }
  };

  const handleEmailLogin = async (password) => {
    setLoginBusy(true);
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, ADMIN_EMAILS[0], password);
      toast.success(t("toast_login_ok"));
      setEmailLoginOpen(false);
    } catch (e) {
      toast.error(t("toast_login_err", e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" ? t("toast_login_wrong_pw") : e.message));
    } finally { setLoginBusy(false); }
  };

  // Collega (o aggiorna) una password all'account admin già loggato con Google, così
  // sulla web app in schermata Home si può accedere con email+password senza dover
  // creare un secondo account: è lo stesso account, con un metodo di accesso in più.
  const [setPasswordOpen, setSetPasswordOpen] = useState(false);
  const handleSetPassword = async (password) => {
    setLoginBusy(true);
    try {
      const credential = EmailAuthProvider.credential(auth.currentUser.email, password);
      try {
        await linkWithCredential(auth.currentUser, credential);
      } catch (e) {
        if (e.code === "auth/provider-already-linked" || e.code === "auth/credential-already-in-use" || e.code === "auth/email-already-in-use") {
          await updatePassword(auth.currentUser, password);
        } else throw e;
      }
      toast.success(t("toast_set_password_ok"));
      setSetPasswordOpen(false);
    } catch (e) {
      toast.error(t("toast_login_err", e.message));
    } finally { setLoginBusy(false); }
  };

  // Da lanciare una volta sola: riporta nel documento pubblico i prezzi che
  // erano stati spostati nella collection separata "can_values" (architettura
  // abbandonata perché causava più problemi — letture che fallivano in
  // silenzio, migrazioni parziali — di quanti ne risolvesse).
  const [migratingPrices, setMigratingPrices] = useState(false);
  const handleMigratePrices = async () => {
    setMigratingPrices(true);
    try {
      const n = await fbRestorePricesToPublicCollection();
      toast.success(t("toast_migrate_ok", n));
      loadCans();
    } catch (e) {
      toast.error(t("toast_login_err", e.message));
    } finally { setMigratingPrices(false); }
  };

  // Da lanciare una volta sola: mette in MAIUSCOLO i dati delle lattine già
  // esistenti che erano state inserite prima che il salvataggio lo facesse
  // in automatico.
  const [uppercasingData, setUppercasingData] = useState(false);
  const handleUppercaseData = async () => {
    setUppercasingData(true);
    try {
      const n = await fbUppercaseAllCanFields();
      toast.success(t("toast_uppercase_ok", n));
      loadCans();
    } catch (e) {
      toast.error(t("toast_login_err", e.message));
    } finally { setUppercasingData(false); }
  };

  useEffect(() => {
    // Chiunque può sfogliare il sito: carichiamo i dati appena l'auth ha finito di
    // risolversi (loggato come admin o no), non solo quando c'è un utente admin.
    // Ricarichiamo anche quando lo stato admin cambia (login/logout), così i
    // prezzi privati vengono recuperati subito dopo il login, e scompaiono
    // subito dopo il logout invece di restare in memoria dalla sessione admin.
    if (!authLoading) loadCans();
  }, [authLoading, admin]);

  useEffect(() => {
    const q = filtersToQuery(filters);
    window.history.replaceState(null, "", window.location.pathname + (q ? "?" + q : ""));
  }, [filters]);

  const loadCans = async () => {
    setLoading(true);
    try {
      const data = await fbGetCans();
      setAllCans(data.map(c => ({ ...c, sku: c.sku ? String(c.sku).replace(/\.0$/, "") : c.sku })));
    } catch (e) { toast.error(t("toast_load_err", e.message)); }
    finally { setLoading(false); }
  };

  const handleLogout = async () => {
    try { await signOut(auth); } catch { /* ignore */ }
  };

  const filtered = useMemo(() => {
    let r = [...cans];
    if (filters.tipo) r = r.filter(c => c.tipo_linea === filters.tipo);
    if (filters.size) r = r.filter(c => c.size === filters.size);
    if (filters.produttore) r = r.filter(c => c.produttore === filters.produttore);
    if (filters.piena_vuota) r = r.filter(c => c.piena_vuota === filters.piena_vuota);
    if (filters.apertura) r = r.filter(c => c.apertura === filters.apertura);
    if (filters.photoOnly) r = r.filter(c => c.photos?.some(p => p));
    if (filters.noPhoto) r = r.filter(c => !c.photos?.some(p => p));
    if (filters.valuedOnly) r = r.filter(c => parseValore(c.valore) > 0);
    if (filters.noValue) r = r.filter(c => !(parseValore(c.valore) > 0));
    if (filters.nazione) r = r.filter(c => c.lingua === filters.nazione);
    if (filters.search) { const s = filters.search.toLowerCase(); r = r.filter(c => (c.nome + " " + c.sku + " " + c.tipo_linea).toLowerCase().includes(s)); }
    if (filters.sort === "name_az") r.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    else if (filters.sort === "name_za") r.sort((a, b) => (b.nome || "").localeCompare(a.nome || ""));
    else if (filters.sort === "sku_asc") r.sort((a, b) => parseSku(a.sku) - parseSku(b.sku));
    else if (filters.sort === "sku_desc") r.sort((a, b) => parseSku(b.sku) - parseSku(a.sku));
    else if (filters.sort === "tipo") r.sort((a, b) => (a.tipo_linea || "").localeCompare(b.tipo_linea || ""));
    else if (filters.sort === "valore_desc") r.sort((a, b) => parseValore(b.valore) - parseValore(a.valore));
    else if (filters.sort === "valore_asc") r.sort((a, b) => parseValore(a.valore) - parseValore(b.valore));
    else if (filters.sort === "recent") r.sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
    return r;
  }, [cans, filters]);

  const totalValue = useMemo(() => cans.reduce((s, c) => s + parseValore(c.valore), 0), [cans]);

  const currentIndex = detailCan ? filtered.findIndex(c => c.id === detailCan.id) : -1;

  const handleSave = async (formData) => {
    try {
      if (editCan) {
        const updated = await fbUpdateCan(editCan.id, formData);
        setAllCans(prev => prev.map(c => c.id === editCan.id ? { ...c, ...formData } : c));
        toast.success(t("toast_can_updated"));
      } else {
        const created = await fbAddCan(formData);
        setAllCans(prev => [created, ...prev]);
        toast.success(t("toast_can_added"));
      }
      setEditOpen(false);
    } catch (e) { toast.error(t("toast_save_err", e.message)); }
  };

  const handleDelete = async () => {
    if (!detailCan) return;
    try {
      await fbDeleteCan(detailCan.id);
      setAllCans(prev => prev.filter(c => c.id !== detailCan.id));
      setDetailOpen(false); toast.success(t("toast_can_deleted"));
    } catch (e) { toast.error(t("toast_delete_err", e.message)); }
  };

  const handleExport = async () => {
    try {
      const XLSX = await loadXLSX();
      const data = cans.map(c => ({ "TIPO LINEA": c.tipo_linea, "NOME": c.nome, "SKU": c.sku, "PRODUTTORE": c.produttore, "SIZE": c.size, "LINGUA": c.lingua, "TOP/TAB": c.top_tab, "PIENA/VUOTA": c.piena_vuota, "APERTURA": c.apertura, "VALORE": c.valore ?? "" }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "COLLEZIONE");
      XLSX.writeFile(wb, "monster_vault_export.xlsx");
      toast.success(t("toast_export_done"));
    } catch { toast.error(t("toast_export_err")); }
  };

  const handleFilterApply = (key, value) => setFilters({ ...DEFAULT_FILTERS, [key]: value });

  if (authLoading) return <><GlobalStyle /><div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}><Spinner /></div></>;

  if (!entered) {
    const heroCountries = new Set(cans.map(c => c.lingua).filter(Boolean)).size;
    const som = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const heroNew = cans.filter(c => c.created_date && c.created_date >= som).length;
    const heroStats = [
      { n: cans.length, l: t("hero_lattine") },
      ...(admin ? [{ n: fmtValore(totalValue, lang), l: t("hero_valore") }] : []),
      { n: heroCountries, l: t("hero_paesi") },
    ];
    return (
      <>
        <GlobalStyle />
        <div className="hero-wrap" style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden", textAlign: "center", padding: "40px 20px", background: "var(--bg)" }}>
          <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 50% at 22% 20%, color-mix(in srgb, var(--primary) 13%, transparent), transparent 60%), radial-gradient(ellipse 55% 45% at 82% 78%, color-mix(in srgb, var(--primary) 9%, transparent), transparent 60%), radial-gradient(ellipse 80% 60% at 50% 50%, var(--secondary), var(--bg) 75%)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(0,255,65,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,65,0.05) 1px, transparent 1px)", backgroundSize: "40px 40px", pointerEvents: "none", maskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, #000, transparent 80%)" }} />
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
            <div className="hero-eyebrow" style={{ ...mono, fontSize: 11, color: "var(--muted-fg)", opacity: 0.6, letterSpacing: "0.45em", textTransform: "uppercase", marginBottom: 22 }}>{t("hero_eyebrow")} · {t("hero_eyebrow_since")}</div>
            <img src={`${import.meta.env.BASE_URL}logo.png`} alt="Monster Vault" className="pulse-glow hero-logo" style={{ width: "clamp(110px,16vw,170px)", height: "clamp(110px,16vw,170px)", borderRadius: "50%", marginBottom: 26, boxShadow: "0 0 70px color-mix(in srgb, var(--primary) 35%, transparent), var(--shadow)" }} />
            <h1 className="hero-title" style={{ ...orbitron, fontSize: "clamp(1.6rem,5.5vw,3.2rem)", color: "var(--fg-strong)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>MONSTER VAULT</h1>
            <div style={{ ...mono, fontSize: 12, color: "var(--primary)", letterSpacing: "0.3em", textTransform: "uppercase", marginBottom: 18 }}>{t("hero_tagline")}</div>
            <p className="hero-desc" style={{ ...mono, fontSize: 13, color: "var(--muted-fg)", lineHeight: 1.7, maxWidth: 440, marginBottom: 34 }}>
              {t("hero_desc")}
            </p>
            <div className="hero-stats" style={{ display: "flex", gap: 0, width: "100%", maxWidth: 420, marginBottom: 12, border: "1px solid var(--border)", background: "var(--card)" }}>
              {heroStats.map((s, i) => (
                <div key={s.l} className="hero-stat" style={{ flex: "1 1 0", padding: "14px 8px", borderLeft: i ? "1px solid var(--border)" : "none", minWidth: 0, textAlign: "center" }}>
                  {loading
                    ? <div className="skeleton" style={{ width: 44, height: 26, borderRadius: 4, margin: "0 auto" }} />
                    : <div className="hero-stat-num" style={{ ...orbitron, fontSize: String(s.n).length > 6 ? 21 : 26, color: "var(--primary)", lineHeight: 1, whiteSpace: "nowrap" }}>{s.n}</div>}
                  <div style={{ ...mono, fontSize: 9, color: "var(--muted-fg)", letterSpacing: "0.15em", marginTop: 5 }}>{s.l}</div>
                </div>
              ))}
            </div>
            <div style={{ ...mono, fontSize: 10, color: heroNew ? "var(--primary)" : "#444", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 34 }}>
              {heroNew ? t("hero_new", heroNew) : t("hero_no_new")}
            </div>
            <button onClick={() => { sessionStorage.setItem("vault_entered", "1"); setEntered(true); }} style={{ ...orbitron, fontSize: 13, background: "var(--primary)", color: "#04140a", border: "none", padding: "14px 46px", borderRadius: 10, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", boxShadow: "var(--shadow)" }}>
              {t("hero_enter")}
            </button>
          </div>
        </div>
        <SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} />
      </>
    );
  }

  if (page === "stats") return <><GlobalStyle /><StatsPage cans={cans} page={page} setPage={setPage} onFilterApply={handleFilterApply} admin={admin} user={user} onLogout={handleLogout} onToggleAdmin={admin ? undefined : handleLogin} loginBusy={loginBusy} onShowRules={() => setRulesOpen(true)} onSetPassword={() => setSetPasswordOpen(true)} onMigratePrices={handleMigratePrices} migratingPrices={migratingPrices} onUppercaseData={handleUppercaseData} uppercasingData={uppercasingData} /><SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} /></>;
  if (page === "mappa") return <><GlobalStyle /><WorldMap cans={cans} page={page} setPage={setPage} onSelectCan={can => { setDetailCan(can); setDetailOpen(true); }} admin={admin} user={user} onLogout={handleLogout} onToggleAdmin={admin ? undefined : handleLogin} loginBusy={loginBusy} onShowRules={() => setRulesOpen(true)} onSetPassword={() => setSetPasswordOpen(true)} onMigratePrices={handleMigratePrices} migratingPrices={migratingPrices} onUppercaseData={handleUppercaseData} uppercasingData={uppercasingData} /><SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} /></>;
  if (page === "doppioni") return <><GlobalStyle /><DuplicatesPage duplicates={duplicates} setAllCans={setAllCans} page={page} setPage={setPage} admin={admin} user={user} onLogout={handleLogout} onToggleAdmin={admin ? undefined : handleLogin} loginBusy={loginBusy} onShowRules={() => setRulesOpen(true)} onSetPassword={() => setSetPasswordOpen(true)} onMigratePrices={handleMigratePrices} migratingPrices={migratingPrices} onUppercaseData={handleUppercaseData} uppercasingData={uppercasingData} /><SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} /></>;
  if (page === "wishlist") return <><GlobalStyle /><WishlistPage sets={sets} cans={cans} setAllCans={setAllCans} page={page} setPage={setPage} admin={admin} user={user} onLogout={handleLogout} onToggleAdmin={admin ? undefined : handleLogin} loginBusy={loginBusy} onShowRules={() => setRulesOpen(true)} onSetPassword={() => setSetPasswordOpen(true)} onMigratePrices={handleMigratePrices} migratingPrices={migratingPrices} onUppercaseData={handleUppercaseData} uppercasingData={uppercasingData} /><SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} /></>;

  return (
    <>
      <GlobalStyle />
      <div style={{ minHeight: "100vh", background: "var(--bg)", paddingBottom: 80 }}>
        <AppHeader page={page} setPage={setPage} user={user} onLogout={handleLogout} admin={admin} onToggleAdmin={admin ? undefined : handleLogin} loginBusy={loginBusy} onShowRules={() => setRulesOpen(true)} onSetPassword={() => setSetPasswordOpen(true)} onMigratePrices={handleMigratePrices} migratingPrices={migratingPrices} onUppercaseData={handleUppercaseData} uppercasingData={uppercasingData}
          onAdd={admin ? () => { setEditCan(null); setEditOpen(true); } : undefined}
          onExport={admin ? handleExport : undefined}
          onImport={admin ? () => setImportOpen(true) : undefined} />
        <FiltersBar cans={cans} filters={filters} setFilters={setFilters} filteredCount={filtered.length} view={view} setView={setView} showValue={admin} />
        {loading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><Spinner /></div>
        ) : (
          <CanGrid cans={filtered} onSelect={can => { setDetailCan(can); setDetailOpen(true); }} view={view} showValue={admin} />
        )}
      </div>
      <DetailModal can={detailCan} open={detailOpen} onClose={() => setDetailOpen(false)}
        onEdit={admin ? () => { setEditCan(detailCan); setEditOpen(true); setDetailOpen(false); } : null}
        onDelete={admin ? handleDelete : null}
        onPrev={currentIndex > 0 ? () => setDetailCan(filtered[currentIndex - 1]) : null}
        onNext={currentIndex < filtered.length - 1 ? () => setDetailCan(filtered[currentIndex + 1]) : null}
        showValue={admin} />
      {admin && <EditModal can={editCan} open={editOpen} onClose={() => setEditOpen(false)} onSave={handleSave} allCans={cans} />}
      {admin && <ImportModal open={importOpen} onClose={() => setImportOpen(false)} existingCans={cans}
        onImportDone={newCans => { setAllCans(prev => [...newCans, ...prev]); setImportOpen(false); }} />}
      <SiteChrome rulesOpen={rulesOpen} onCloseRules={handleCloseRules} cookiesAccepted={cookiesAccepted} onAcceptCookies={handleAcceptCookies} emailLoginOpen={emailLoginOpen} onCloseEmailLogin={() => setEmailLoginOpen(false)} onEmailLogin={handleEmailLogin} setPasswordOpen={setPasswordOpen} onCloseSetPassword={() => setSetPasswordOpen(false)} onSetPassword={handleSetPassword} loginBusy={loginBusy} />
    </>
  );
}
