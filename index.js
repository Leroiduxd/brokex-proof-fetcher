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
  aapl_usd: { id: 6004, name: "APPLE INC.",            cat: "equity" },
  amzn_usd: { id: 6005, name: "AMAZON",                cat: "equity" },
  coin_usd: { id: 6010, name: "COINBASE",              cat: "equity" },
  goog_usd: { id: 6003, name: "ALPHABET INC.",         cat: "equity" },
  gme_usd:  { id: 6011, name: "GAMESTOP CORP.",        cat: "equity" },
  intc_usd: { id: 6009, name: "INTEL CORPORATION",     cat: "equity" },
  ko_usd:   { id: 6059, name: "COCA-COLA CO",          cat: "equity" },
  mcd_usd:  { id: 6068, name: "MCDONALD'S CORP",       cat: "equity" },
  msft_usd: { id: 6001, name: "MICROSOFT CORP",        cat: "equity" },
  ibm_usd:  { id: 6066, name: "IBM",                   cat: "equity" },
  meta_usd: { id: 6006, name: "META PLATFORMS INC.",   cat: "equity" },
  nvda_usd: { id: 6002, name: "NVIDIA CORP",           cat: "equity" },
  tsla_usd: { id: 6000, name: "TESLA INC",             cat: "equity" },

  aud_usd:  { id: 5010, name: "AUSTRALIAN DOLLAR",     cat: "fxcom" },
  eur_usd:  { id: 5000, name: "EURO",                  cat: "fxcom" },
  gbp_usd:  { id: 5002, name: "GREAT BRITAIN POUND",   cat: "fxcom" },
  nzd_usd:  { id: 5013, name: "NEW ZEALAND DOLLAR",    cat: "fxcom" },
  usd_cad:  { id: 5011, name: "CANADIAN DOLLAR",       cat: "fxcom" },
  usd_chf:  { id: 5012, name: "SWISS FRANC",           cat: "fxcom" },
  usd_jpy:  { id: 5001, name: "JAPANESE YEN",          cat: "fxcom" },

  xag_usd:  { id: 5501, name: "SILVER",                cat: "fxcom" },
  xau_usd:  { id: 5500, name: "GOLD",                  cat: "fxcom" },
  wti_usd:  { id: 5503, name: "WEST TEXAS INTERMEDIATE CRUDE", cat: "fxcom" },

  btc_usdt: { id: 0,    name: "BITCOIN",               cat: "crypto" },
  eth_usdt: { id: 1,    name: "ETHEREUM",              cat: "crypto" },
  sol_usdt: { id: 10,   name: "SOLANA",                cat: "crypto" },
  xrp_usdt: { id: 14,   name: "RIPPLE",                cat: "crypto" },
  avax_usdt:{ id: 5,    name: "AVALANCHE",             cat: "crypto" },
  doge_usdt:{ id: 3,    name: "DOGECOIN",              cat: "crypto" },
  trx_usdt: { id: 15,   name: "TRON",                  cat: "crypto" },
  ada_usdt: { id: 16,   name: "CARDANO",               cat: "crypto" },
  sui_usdt: { id: 90,   name: "SUI",                   cat: "crypto" },
  link_usdt:{ id: 2,    name: "CHAINLINK",             cat: "crypto" },

  orcle_usd:{ id: 6038, name: "ORACLE CORPORATION",    cat: "equity" },

  nike_usd: { id: 6034, name: "NIKE INC",              cat: "equity" },
  spdia_usd:{ id: 6113, name: "SPDR S&P 500 ETF",      cat: "index" },
  qqqm_usd: { id: 6114, name: "NASDAQ-100 ETF",        cat: "index" },
  iwm_usd:  { id: 6115, name: "ISHARES RUSSELL 2000 ETF", cat: "index" }
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
