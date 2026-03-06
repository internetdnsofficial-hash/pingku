async function tursoQuery(sql, args = []) {
  const url = process.env.TURSO_DATABASE_URL.replace("libsql://", "https://");
  const token = process.env.TURSO_AUTH_TOKEN;
  const res = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: args.map((a) => ({ type: "text", value: String(a) })) } },
        { type: "close" },
      ],
    }),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Turso error ${res.status}: ${err}`); }
  return await res.json();
}

// Layanan standar (selalu dipanggil)
const STANDARD_SERVICES = [
  { name: "Yandex", url: "https://webmaster.yandex.com/ping", type: "get", param: "sitemap" },
  { name: "Ping-o-Matic", url: "http://rpc.pingomatic.com/", type: "xmlrpc", method: "weblogUpdates.extendedPing" },
  { name: "WordPress.com", url: "http://wordpress.com/xmlrpc.php", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "Feedshark", url: "http://feedshark.brainbliss.com", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "RPC2 Weblogs", url: "http://rpc.weblogs.com/RPC2", type: "xmlrpc", method: "weblogUpdates.extendedPing" },
  { name: "Ping.in", url: "http://ping.in/", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "RSSMicro", url: "http://www.rssmicro.com/ping", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "Blogsnow", url: "http://blogsnow.com/ping", type: "xmlrpc", method: "weblogUpdates.ping" },
];

// Layanan IndexNow (hanya dipanggil jika ada API key)
const INDEXNOW_SERVICES = [
  { name: "Google (IndexNow)", url: "https://api.indexnow.org/indexnow", type: "indexnow" },
  { name: "Bing (IndexNow)", url: "https://www.bing.com/indexnow", type: "indexnow" },
  { name: "Yandex (IndexNow)", url: "https://yandex.com/indexnow", type: "indexnow" },
  { name: "Seznam (IndexNow)", url: "https://search.seznam.cz/indexnow", type: "indexnow" },
  { name: "Naver (IndexNow)", url: "https://searchadvisor.naver.com/indexnow", type: "indexnow" },
];

async function pingGetService(service, url) {
  try {
    const pingUrl = `${service.url}?${service.param}=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(pingUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return { name: service.name, success: res.ok, status: res.status };
  } catch { return { name: service.name, success: false, status: "timeout" }; }
}

async function pingXmlRpcService(service, blogName, url) {
  try {
    const xmlBody = `<?xml version="1.0"?><methodCall><methodName>${service.method}</methodName><params><param><value><string>${blogName}</string></value></param><param><value><string>${url}</string></value></param></params></methodCall>`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(service.url, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: xmlBody,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { name: service.name, success: res.ok, status: res.status };
  } catch { return { name: service.name, success: false, status: "timeout" }; }
}

async function pingIndexNow(service, url, key) {
  try {
    const pingUrl = `${service.url}?url=${encodeURIComponent(url)}&key=${key}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(pingUrl, { signal: controller.signal });
    clearTimeout(timeout);
    // IndexNow returns 200 or 202 for success
    return { name: service.name, success: res.status === 200 || res.status === 202, status: res.status };
  } catch { return { name: service.name, success: false, status: "timeout" }; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { url, blogName = "My Blog", indexnowKey = "" } = body;
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: "URL is required" }) };
  try { new URL(url); } catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid URL format" }) }; }

  try {
    await tursoQuery(`CREATE TABLE IF NOT EXISTS pings (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, blog_name TEXT, success_count INTEGER, total_services INTEGER, results TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e) { console.error("Create table:", e.message); }

  // Tentukan services yang akan dipakai
  const services = [...STANDARD_SERVICES];
  if (indexnowKey) services.push(...INDEXNOW_SERVICES);

  const settled = await Promise.allSettled(
    services.map((s) => {
      if (s.type === "get") return pingGetService(s, url);
      if (s.type === "indexnow") return pingIndexNow(s, url, indexnowKey);
      return pingXmlRpcService(s, blogName, url);
    })
  );

  const results = settled.map((r) => r.status === "fulfilled" ? r.value : { name: "Unknown", success: false, status: "error" });
  const successCount = results.filter((r) => r.success).length;

  try {
    await tursoQuery(
      `INSERT INTO pings (url, blog_name, success_count, total_services, results) VALUES (?, ?, ?, ?, ?)`,
      [url, blogName, successCount, services.length, JSON.stringify(results)]
    );
  } catch (e) { console.error("DB insert:", e.message); }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, url, blogName, successCount, totalServices: services.length, results }),
  };
};
