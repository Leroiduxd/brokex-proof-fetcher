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
const INTERVAL_MS    = Number(process.env.INTERVAL_MS ?? 5000);
const ASSET_IDS_OVERRIDE = process.env.ASSET_IDS_OVERRIDE ?? ""; // ex: "0-17,5000-5600,6000-6060"

/* =================== VALIDATION =================== */
if (!RPC_URL || !CONTRACT_ADDR || !PRIVATE_KEY) {
  console.error("❌ Manque RPC_URL, CONTRACT_ADDR ou PRIVATE_KEY dans .env");
  process.exit(1);
}

/* =================== ASSETS MAP =================== */
/** Tu gères les idées; je m'occupe de la logique/horaires. */
const ASSETS = {
  btc_usdt: { id: 0,    name: "BITCOIN",               cat: "crypto" }
};

// IDs connus (si pas override on utilisera l’ensemble de ce mapping)
const ALL_IDS = Array.from(new Set(Object.values(ASSETS).map(a => a.id))).sort((a,b)=>a-b);

/* =================== HELPERS =================== */
function expandRanges(spec) {
  if (!spec) return [];
  const out = new Set();
  spec.split(",").map(s => s.trim()).filter(Boolean).forEach(token => {
    if (token.includes("-")) {
      const [a,b] = token.split("-").map(Number);
      const start = Math.min(a,b), end = Math.max(a,b);
      for (let i = start; i <= end; i++) out.add(i);
    } else {
      out.add(Number(token));
    }
  });
  return Array.from(out).sort((x,y)=>x-y);
}

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

// Catégorie par ID si jamais tu rajoutes des IDs hors mapping
function inferCategoryById(id) {
  if (id >= 0 && id <= 1000) return "crypto";
  if ((id >= 5000 && id <= 5600) || (id >= 5500 && id <= 5599)) return "fxcom";
  if (id >= 6000) return "equity"; // fallback
  return "unknown";
}

function getCategory(id) {
  // D’abord, tente de trouver dans le mapping
  const found = Object.values(ASSETS).find(a => a.id === id);
  if (found?.cat) return found.cat;
  return inferCategoryById(id);
}

// Fenêtres horaires par catégorie
function isAllowedNowByCategory(cat, nowUTC = DateTime.utc()) {
  const nowNY = nowUTC.setZone("America/New_York");
  const weekday = nowNY.weekday; // 1=Mon ... 7=Sun

  switch (cat) {
    case "crypto":
      // en continu (24/7)
      return true;

    case "fxcom":
    case "index":
      // tout le temps hors week-end (lun–ven)
      return weekday >= 1 && weekday <= 5;

    case "equity":
      // actions : lun–ven 09:30–16:30 NY
      if (!(weekday >= 1 && weekday <= 5)) return false;
      const minutes = nowNY.hour * 60 + nowNY.minute;
      return minutes >= (9*60+30) && minutes <= (16*60+30);

    default:
      return false;
  }
}

/* =================== ETHERS =================== */
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const ABI = [ "function ingestProof(bytes _bytesProof) external" ];
const contract = new ethers.Contract(CONTRACT_ADDR, ABI, wallet);

/* =================== LOOP STATE =================== */
const MONITORED_IDS = ASSET_IDS_OVERRIDE ? expandRanges(ASSET_IDS_OVERRIDE) : ALL_IDS;
let busy = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* =================== CORE =================== */
async function tick() {
  if (busy) return;
  busy = true;
  const started = Date.now();
  try {
    const now = DateTime.utc();

    // Filtrer par catégorie/horaires
    const allowed = MONITORED_IDS.filter(id => isAllowedNowByCategory(getCategory(id), now));
    if (allowed.length === 0) {
      log("⏭️  Aucune paire autorisée maintenant.");
      return;
    }

    // Chunk pour éviter des URLs trop longues
    const groups = chunk(allowed, 200);
    for (const group of groups) {
      const qs = encodeURIComponent(group.join(","));
      const url = `${PROOF_BASE_URL}?pairs=${qs}`;

      // Fetch de la preuve + retry
      const { proof } = await pRetry(async () => {
        const r = await fetch(url, { headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j.proof || typeof j.proof !== "string" || !j.proof.startsWith("0x")) {
          throw new Error("Réponse invalide: 'proof' manquant/malformé.");
        }
        return j;
      }, { retries: 3, factor: 1.6, minTimeout: 400, maxTimeout: 1500 });

      // Envoi on-chain + retry
      const tx = await pRetry(async () => {
        return await contract.ingestProof(proof);
      }, { retries: 2, factor: 1.5, minTimeout: 500, maxTimeout: 2000 });

      log(`✅ Tx envoyée: ${tx.hash} | pairs=${group.length} [ex: ${group.slice(0,6).join(",")}${group.length>6?"...":""}]`);
      // Option: attendre confirmation
      // const rcpt = await tx.wait();
      // log(`⛏️ Confirmée block=${rcpt.blockNumber}`);
    }

  } catch (e) {
    log(`❌ Erreur: ${e?.message || e}`);
  } finally {
    busy = false;
    const dur = Date.now() - started;
    if (dur > INTERVAL_MS) log(`⚠️ Tick=${dur}ms (> ${INTERVAL_MS}ms)`);
  }
}

/* =================== START =================== */
(async () => {
  const net = await provider.getNetwork();
  log(`🚀 Proof Ingestor lancé | chainId=${net.chainId}`);
  log(`RPC=${RPC_URL}`);
  log(`Contract=${CONTRACT_ADDR}`);
  log(`Monitored IDs=${MONITORED_IDS.join(",")}`);
  log(`Interval=${INTERVAL_MS}ms | TZ=America/New_York for schedule`);

  await tick();
  setInterval(tick, INTERVAL_MS);
})();
