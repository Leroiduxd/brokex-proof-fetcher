// index.js
import "dotenv/config";
import { DateTime } from "luxon";
import { ethers } from "ethers";
import pRetry from "p-retry";

/* =================== CONFIG ENV =================== */
const RPC_URL        = process.env.RPC_URL;
const CONTRACT_ADDR  = process.env.CONTRACT_ADDR;
const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const PROOF_BASE_URL = process.env.PROOF_BASE_URL ?? "https://proof.brokex.trade/proof";
const INTERVAL_MS    = Number(process.env.INTERVAL_MS ?? 15000); // 15 s par défaut
const ASSET_IDS_OVERRIDE = process.env.ASSET_IDS_OVERRIDE ?? ""; // ex: "0-17,5000-5600,6000-6060"

/* =================== VALIDATION =================== */
if (!RPC_URL || !CONTRACT_ADDR || !PRIVATE_KEY) {
  console.error("❌ Manque RPC_URL, CONTRACT_ADDR ou PRIVATE_KEY dans .env");
  process.exit(1);
}

/* =================== ID RANGES =================== */
// Crypto:   0 <= id < 100        (24/7)
// FX/Métaux:5000 <= id <= 5600   (lun–ven 00:00–24:00 NY)
// Actions:  6000 <= id < 6100    (lun–ven 09:30–16:30 NY)
// Indices:  6100 <= id < 6200    (lun–ven 00:00–24:00 NY)

function rangeInclusive(a, b) {
  const out = [];
  const start = Math.min(a, b), end = Math.max(a, b);
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}
function rangeHalfOpen(a, b) { // [a,b)
  const out = [];
  for (let i = a; i < b; i++) out.push(i);
  return out;
}

/* =================== HELPERS =================== */
function expandRanges(spec) {
  if (!spec) return [];
  const out = new Set();
  spec.split(",").map(s => s.trim()).filter(Boolean).forEach(token => {
    if (token.includes("-")) {
      const [A, B] = token.split("-").map(Number);
      const start = Math.min(A, B), end = Math.max(A, B);
      for (let i = start; i <= end; i++) out.add(i);
    } else {
      out.add(Number(token));
    }
  });
  return Array.from(out).filter(Number.isFinite).sort((x,y)=>x-y);
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

function getCategoryById(id) {
  if (id >= 0 && id < 100) return "crypto";
  if (id >= 5000 && id <= 5600) return "fxcom";
  if (id >= 6000 && id < 6100) return "equity";
  if (id >= 6100 && id < 6200) return "index";
  return "unknown";
}

// Horaires par catégorie (America/New_York)
function isAllowedNowByCategory(cat, nowUTC = DateTime.utc()) {
  const nowNY = nowUTC.setZone("America/New_York");
  const weekday = nowNY.weekday; // 1 = lundi ... 7 = dimanche
  const minutes = nowNY.hour * 60 + nowNY.minute;

  switch (cat) {
    case "crypto":
      return true; // 24/7

    case "fxcom":
    case "index":
      return weekday >= 1 && weekday <= 5; // du lundi au vendredi, toute la journée

    case "equity":
      if (!(weekday >= 1 && weekday <= 5)) return false;
      return minutes >= (9*60 + 30) && minutes <= (16*60 + 30); // 9h30–16h30 NY

    default:
      return false;
  }
}

/* =================== ETHERS =================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const ABI = [ "function ingestProof(bytes _bytesProof) external" ];
const contract = new ethers.Contract(CONTRACT_ADDR, ABI, wallet);

/* =================== MONITORED IDS =================== */
const DEFAULT_ALL_IDS = [
  ...rangeHalfOpen(0, 100),      // crypto
  ...rangeInclusive(5000, 5600), // forex & métaux
  ...rangeHalfOpen(6000, 6100),  // actions
  ...rangeHalfOpen(6100, 6200),  // indices
];
const MONITORED_IDS = ASSET_IDS_OVERRIDE
  ? expandRanges(ASSET_IDS_OVERRIDE)
  : Array.from(new Set(DEFAULT_ALL_IDS)).sort((a,b)=>a-b);

/* =================== LOGGING & STATE =================== */
let busy = false;
const MAX_PER_PROOF = 200; // taille max par batch
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

/* =================== FETCH PROOF =================== */
async function fetchProof(url) {
  const proof = await pRetry(async () => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const j = await r.json();

    if (!j.proof || typeof j.proof !== "string")
      throw new Error("Réponse invalide: champ 'proof' manquant.");
    const p = j.proof.trim();
    if (p === "" || p === "0x")
      throw new Error("Preuve vide reçue du serveur.");
    if (!p.startsWith("0x"))
      throw new Error("Preuve mal formée (doit commencer par 0x).");

    return p;
  }, { retries: 3, factor: 1.6, minTimeout: 400, maxTimeout: 1500 });

  return proof;
}

/* =================== CORE =================== */
async function tick() {
  if (busy) return;
  busy = true;
  const started = Date.now();

  try {
    const now = DateTime.utc();
    const allowed = MONITORED_IDS.filter(id =>
      isAllowedNowByCategory(getCategoryById(id), now)
    );

    if (allowed.length === 0) {
      log("⏭️  Aucune paire autorisée maintenant.");
      return;
    }

    const groups = chunk(allowed, MAX_PER_PROOF);
    for (const group of groups) {
      const qs = encodeURIComponent(group.join(","));
      const url = `${PROOF_BASE_URL}?pairs=${qs}`;

      // Récupération de la preuve
      const proof = await fetchProof(url);

      // Envoi on-chain avec retry
      const tx = await pRetry(async () => {
        return await contract.ingestProof(proof);
      }, { retries: 2, factor: 1.5, minTimeout: 500, maxTimeout: 2000 });

      log(`✅ Tx envoyée: ${tx.hash} | pairs=${group.length} [ex: ${group.slice(0,6).join(",")}${group.length>6?"...":""}]`);
      await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random()*300))); // petit jitter
    }

  } catch (e) {
    log(`❌ Erreur: ${e?.message || e}`);
  } finally {
    busy = false;
    const dur = Date.now() - started;
    if (dur > INTERVAL_MS) log(`⚠️ Tick=${dur}ms (> ${INTERVAL_MS}ms)`);
  }
}

/* =================== LOOP =================== */
(async () => {
  const net = await provider.getNetwork();
  log(`🚀 Proof Ingestor lancé | chainId=${net.chainId}`);
  log(`RPC=${RPC_URL}`);
  log(`Contract=${CONTRACT_ADDR}`);
  log(`Monitored IDs (${MONITORED_IDS.length}) = ${MONITORED_IDS[0]}…${MONITORED_IDS[MONITORED_IDS.length-1]}`);
  log(`Interval=${INTERVAL_MS}ms (${(INTERVAL_MS/1000).toFixed(0)} s) | TZ=America/New_York`);

  // boucle avec jitter pour éviter les collisions
  async function loop() {
    await tick();
    const jitter = Math.floor(Math.random() * 300); // 0–300 ms
    setTimeout(loop, INTERVAL_MS + jitter);
  }
  await loop();
})();


