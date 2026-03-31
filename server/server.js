import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { exec } from "node:child_process";

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.XRAY_API_KEY || "";
const SCRIPTS_DIR = "/app/scripts";
const OUTPUT_BASE = "/tmp/xray-scans";

fs.mkdirSync(OUTPUT_BASE, { recursive: true });

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(data));
}

function stream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  return (data) => {
    try { res.write(JSON.stringify(data) + "\n"); } catch {}
  };
}

function auth(req) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || "";
  return h === `Bearer ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// Tar a directory into a stream
function tarDir(dir) {
  return spawn("tar", ["-czf", "-", "-C", path.dirname(dir), path.basename(dir)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/health") {
    return json(res, 200, { status: "ok", engines: ["v5", "v6", "v7"] });
  }

  if (!auth(req)) return json(res, 401, { error: "Unauthorized" });

  // POST /scan — run x-ray and stream output
  if (req.method === "POST" && url.pathname === "/scan") {
    const body = await readBody(req);
    const { url: targetUrl, version = "v7", maxPages = 1 } = body;

    if (!targetUrl || !targetUrl.startsWith("http")) {
      return json(res, 400, { error: "Invalid URL" });
    }

    const safeVersion = version.replace(/[^a-z0-9]/g, "");
    const scriptPath = path.join(SCRIPTS_DIR, `${safeVersion}-stable.cjs`);

    if (!fs.existsSync(scriptPath)) {
      return json(res, 404, { error: `Engine ${safeVersion} not found` });
    }

    let hostname;
    try { hostname = new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { hostname = "unknown"; }
    const scanId = `${hostname}-${Date.now()}`;
    const outDir = path.join(OUTPUT_BASE, scanId);

    const send = stream(res);
    send({ type: "log", text: `Engine: ${safeVersion}-stable.js`, level: "info" });
    send({ type: "log", text: `Target: ${targetUrl}`, level: "accent" });
    send({ type: "log", text: `Scan ID: ${scanId}`, level: "dim" });
    send({ type: "log", text: "", level: "dim" });

    const proc = spawn("node", [scriptPath, targetUrl, outDir, String(maxPages)], {
      env: { ...process.env, NODE_PATH: "/app/node_modules" },
      cwd: SCRIPTS_DIR,
      timeout: 300000,
    });

    let lastLine = "";
    function handleOutput(data) {
      for (const line of data.toString().split("\n")) {
        const t = line.trim();
        if (!t || t === lastLine) continue;
        lastLine = t;
        let level = "info";
        if (t.includes("✅") || t.includes("✓")) level = "success";
        else if (t.includes("❌") || t.includes("✗")) level = "error";
        else if (t.includes("🔬") || t.includes("🎨") || t.includes("📦")) level = "accent";
        else if (t.startsWith("     ")) level = "dim";
        send({ type: "log", text: t, level });
      }
    }

    proc.stdout.on("data", handleOutput);
    proc.stderr.on("data", handleOutput);

    proc.on("close", (code) => {
      // Count output
      const stats = { pages: 0, images: 0, fonts: 0, videos: 0 };
      try {
        if (fs.existsSync(path.join(outDir, "images")))
          stats.images = fs.readdirSync(path.join(outDir, "images")).length;
        if (fs.existsSync(path.join(outDir, "fonts")))
          stats.fonts = fs.readdirSync(path.join(outDir, "fonts")).length;
        if (fs.existsSync(path.join(outDir, "videos")))
          stats.videos = fs.readdirSync(path.join(outDir, "videos")).length;
        stats.pages = fs.readdirSync(outDir).filter(f => f.endsWith(".html")).length;
      } catch {}

      send({ type: "done", scanId, dir: outDir, stats, code });
      res.end();
    });

    proc.on("error", (err) => {
      send({ type: "error", text: `Process error: ${err.message}` });
      res.end();
    });

    return;
  }

  // GET /download/:scanId — download scan as tar.gz
  if (req.method === "GET" && url.pathname.startsWith("/download/")) {
    const scanId = url.pathname.split("/download/")[1];
    if (!scanId || scanId.includes("..")) return json(res, 400, { error: "Invalid scan ID" });

    const scanDir = path.join(OUTPUT_BASE, scanId);
    if (!fs.existsSync(scanDir)) return json(res, 404, { error: "Scan not found" });

    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${scanId}.tar.gz"`,
      "Access-Control-Allow-Origin": "*",
    });

    const tar = tarDir(scanDir);
    tar.stdout.pipe(res);
    tar.on("close", () => res.end());
    return;
  }

  // GET /preview/:scanId/* — serve cloned site files
  if (req.method === "GET" && url.pathname.startsWith("/preview/")) {
    const parts = url.pathname.replace("/preview/", "").split("/");
    const scanId = parts[0];
    if (!scanId || scanId.includes("..")) return json(res, 400, { error: "Invalid scan ID" });

    const scanDir = path.join(OUTPUT_BASE, scanId);
    if (!fs.existsSync(scanDir)) return json(res, 404, { error: "Scan not found" });

    let filePath = parts.slice(1).join("/") || "index.html";
    if (filePath.includes("..")) return json(res, 400, { error: "Invalid path" });

    const fullPath = path.join(scanDir, filePath);
    if (!fs.existsSync(fullPath)) return json(res, 404, { error: "File not found" });

    const ext = path.extname(fullPath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
      ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
      ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
      ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
      ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm",
    };
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // GET /scans — list available scans
  if (req.method === "GET" && url.pathname === "/scans") {
    try {
      const dirs = fs.readdirSync(OUTPUT_BASE).filter(d =>
        fs.statSync(path.join(OUTPUT_BASE, d)).isDirectory()
      );
      const scans = dirs.map(d => {
        const dir = path.join(OUTPUT_BASE, d);
        const stats = { pages: 0, images: 0, fonts: 0, videos: 0 };
        try {
          if (fs.existsSync(path.join(dir, "images")))
            stats.images = fs.readdirSync(path.join(dir, "images")).length;
          if (fs.existsSync(path.join(dir, "fonts")))
            stats.fonts = fs.readdirSync(path.join(dir, "fonts")).length;
          if (fs.existsSync(path.join(dir, "videos")))
            stats.videos = fs.readdirSync(path.join(dir, "videos")).length;
          stats.pages = fs.readdirSync(dir).filter(f => f.endsWith(".html")).length;
        } catch {}
        return { id: d, ...stats };
      }).reverse();
      return json(res, 200, scans);
    } catch {
      return json(res, 200, []);
    }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Site X-Ray Server running on port ${PORT}`);
});
