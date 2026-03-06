// Menggunakan Turso HTTP API langsung
async function tursoQuery(sql, args = []) {
  const url = process.env.TURSO_DATABASE_URL.replace("libsql://", "https://");
  const token = process.env.TURSO_AUTH_TOKEN;

  const res = await fetch(`${url}/v2/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql, args: args.map((a) => ({ type: "text", value: String(a) })) } },
        { type: "close" },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Turso error ${res.status}: ${err}`);
  }

  return await res.json();
}

// Layanan ping yang masih aktif di 2025
const PING_SERVICES = [
  // GET-based (masih aktif)
  { name: "Yandex", url: "https://webmaster.yandex.com/ping", type: "get", param: "sitemap" },
  { name: "IndexNow (Bing)", url: "https://www.bing.com/indexnow", type: "get", param: "url" },
  { name: "IndexNow (Yandex)", url: "https://yandex.com/indexnow", type: "get", param: "url" },
  { name: "IndexNow (Seznam)", url: "https://search.seznam.cz/indexnow", type: "get", param: "url" },
  { name: "IndexNow (Naver)", url: "https://searchadvisor.naver.com/indexnow", type: "get", param: "url" },

  // XML-RPC yang masih aktif
  { name: "Ping-o-Matic", url: "http://rpc.pingomatic.com/", type: "xmlrpc", method: "weblogUpdates.extendedPing" },
  { name: "WordPress.com", url: "http://wordpress.com/xmlrpc.php", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "Feedshark", url: "http://feedshark.brainbliss.com", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "RPC2 (weblogs)", url: "http://rpc.weblogs.com/RPC2", type: "xmlrpc", method: "weblogUpdates.extendedPing" },
  { name: "Ping.in", url: "http://ping.in/", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "BlogEasy", url: "http://blogeasy.com/ping", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "RSSMicro", url: "http://www.rssmicro.com/ping", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "FeedBurner RPC", url: "http://ping.feedburner.com", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "Blogsnow", url: "http://blogsnow.com/ping", type: "xmlrpc", method: "weblogUpdates.ping" },
  { name: "Total Ping", url: "http://www.totalping.com/ping.php", type: "xmlrpc", method: "weblogUpdates.ping" },
];

async function pingGetService(service, url) {
  try {
    const pingUrl = `${service.url}?${service.param}=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(pingUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return { name: service.name, success: res.ok, status: res.status };
  } catch {
    return { name: service.name, success: false, status: "timeout" };
  }
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
  } catch {
    return { name: service.name, success: false, status: "timeout" };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { url, blogName = "My Blog" } = body;
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: "URL is required" }) };
  try { new URL(url); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid URL format" }) };
  }

  try {
    await tursoQuery(`CREATE TABLE IF NOT EXISTS pings (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, blog_name TEXT, success_count INTEGER, total_services INTEGER, results TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e) { console.error("Create table:", e.message); }

  const settled = await Promise.allSettled(
    PING_SERVICES.map((s) => s.type === "get" ? pingGetService(s, url) : pingXmlRpcService(s, blogName, url))
  );
  const results = settled.map((r) => r.status === "fulfilled" ? r.value : { name: "Unknown", success: false, status: "error" });
  const successCount = results.filter((r) => r.success).length;

  try {
    await tursoQuery(
      `INSERT INTO pings (url, blog_name, success_count, total_services, results) VALUES (?, ?, ?, ?, ?)`,
      [url, blogName, successCount, PING_SERVICES.length, JSON.stringify(results)]
    );
  } catch (e) { console.error("DB insert:", e.message); }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: true, url, blogName, successCount, totalServices: PING_SERVICES.length, results }),
  };
};