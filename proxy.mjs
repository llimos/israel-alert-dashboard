import { createServer } from "http";

const PORT = 3000;

const OREF_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Referer: "https://www.oref.org.il/",
  "X-Requested-With": "XMLHttpRequest",
};

const UPSTREAM = {
  "/oref": fetchMergedAlerts,
  "/emess": () => fetchRaw("https://www.emess.co.il/Online/Feed/0", { "User-Agent": "Mozilla/5.0" }),
};

// ── Fetching ──────────────────────────────────────────────────────────────

async function fetchRaw(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

async function fetchJson(url, headers) {
  const text = await fetchRaw(url, headers);
  return JSON.parse(text);
}

// ── Alert normalization ───────────────────────────────────────────────────

function normalizeAlert(item) {
  return {
    alertDate: item.alertDate,
    title: item.title ?? item.category_desc,
    data: item.data,
    category: item.category,
  };
}

function deduplicationKey(alert) {
  const normalized = alert.alertDate.replace("T", " ").slice(0, 16);
  return `${normalized}|${alert.data}`;
}

function deduplicateAlerts(alerts) {
  const seen = new Set();
  return alerts.filter((a) => {
    const key = deduplicationKey(a);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchMergedAlerts() {
  const [primary, history] = await Promise.allSettled([
    fetchJson("https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json", OREF_HEADERS),
    fetchJson("https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx", OREF_HEADERS),
  ]);

  const fromPrimary =
    primary.status === "fulfilled" && Array.isArray(primary.value) ? primary.value.map(normalizeAlert) : [];

  const fromHistory =
    history.status === "fulfilled" && Array.isArray(history.value) ? history.value.map(normalizeAlert) : [];

  if (!fromPrimary.length && !fromHistory.length) {
    throw new Error("Both oref sources failed");
  }

  return JSON.stringify(deduplicateAlerts([...fromPrimary, ...fromHistory]));
}

// ── Server ────────────────────────────────────────────────────────────────

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  const handler = UPSTREAM[path];

  if (!handler) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  try {
    const body = await handler();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  } catch (err) {
    res.writeHead(502);
    res.end(`Upstream error: ${err.message}`);
  }
}).listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
  console.log(`  /oref  → merged AlertsHistory.json + GetAlarmsHistory.aspx`);
  console.log(`  /emess → emess.co.il/Online/Feed/0`);
});
