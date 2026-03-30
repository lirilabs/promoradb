import fetch from "node-fetch";

// ===============================
// 🔒 Rate Limiter
// ===============================
const rateLimiter = new Map();

function checkRateLimit(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const reqs = rateLimiter.get(ip) || [];

  const recent = reqs.filter((t) => now - t < windowMs);
  if (recent.length >= limit) return false;

  recent.push(now);
  rateLimiter.set(ip, recent);
  return true;
}

// ===============================
// ✅ Validators
// ===============================
function isValidSegment(val) {
  return val && /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

function isValidFilename(val) {
  return val && /^[a-zA-Z0-9_\-\.]{1,255}$/.test(val);
}

// ===============================
// 🚀 Handler
// ===============================
export default async function handler(req, res) {

  // ── Security Headers ─────────────────────────
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "DELETE") {
    return res.status(405).json({
      error: "Method not allowed",
      allowed: ["DELETE"]
    });
  }

  // ── Rate Limit ───────────────────────────────
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Too many requests. Please try again later."
    });
  }

  // ── Env Check ────────────────────────────────
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({
      error: "Server configuration error"
    });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const { uid, promptId, filename } = req.query;

  // ── Validate Input ───────────────────────────
  if (!isValidSegment(uid)) {
    return res.status(400).json({ error: "Invalid or missing uid" });
  }

  if (!isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid or missing promptId" });
  }

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;

  // ======================================================
  // 🖼 DELETE SINGLE IMAGE
  // ======================================================
  if (filename) {

    if (!isValidFilename(filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const githubPath = `${uid}/${promptId}/images/${filename}`;
    const encodedPath = githubPath.split("/").map(encodeURIComponent).join("/");

    // 1️⃣ Fetch file to get SHA
    let fileResp;
    try {
      fileResp = await fetch(`${base}/${encodedPath}`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "PromoraDB-Delete/1.0"
        }
      });
    } catch (err) {
      console.error("Fetch file error:", err);
      return res.status(500).json({ error: "Failed to access file" });
    }

    if (!fileResp.ok) {
      return res.status(404).json({ error: "Image not found" });
    }

    const fileData = await fileResp.json();
    const sha = fileData.sha;

    // 2️⃣ Delete file
    let deleteResp;
    try {
      deleteResp = await fetch(`${base}/${encodedPath}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "PromoraDB-Delete/1.0"
        },
        body: JSON.stringify({
          message: `Delete image ${filename}`,
          sha,
          branch
        })
      });
    } catch (err) {
      console.error("Delete error:", err);
      return res.status(500).json({ error: "Delete request failed" });
    }

    if (!deleteResp.ok) {
      const errBody = await deleteResp.json().catch(() => ({}));
      return res.status(deleteResp.status).json({
        error: "Failed to delete image",
        details: process.env.NODE_ENV === "development" ? errBody : undefined
      });
    }

    return res.status(200).json({
      success: true,
      type: "single",
      deleted: filename,
      path: githubPath
    });
  }

  // ======================================================
  // 🗂 DELETE FULL PROJECT
  // ======================================================
  const dirPath = `${uid}/${promptId}/images`;
  const encodedDir = dirPath.split("/").map(encodeURIComponent).join("/");

  let listResp;
  try {
    listResp = await fetch(`${base}/${encodedDir}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "PromoraDB-Delete/1.0"
      }
    });
  } catch (err) {
    console.error("List error:", err);
    return res.status(500).json({ error: "Failed to list project files" });
  }

  if (!listResp.ok) {
    if (listResp.status === 404) {
      return res.status(404).json({ error: "Project not found" });
    }
    return res.status(listResp.status).json({ error: "Failed to fetch project files" });
  }

  const files = await listResp.json();

  const results = [];

  // Delete all files sequentially (safe approach)
  for (const file of files) {

    if (file.type !== "file") continue;

    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");

    try {
      const delResp = await fetch(`${base}/${encodedPath}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "PromoraDB-Delete/1.0"
        },
        body: JSON.stringify({
          message: `Delete ${file.name}`,
          sha: file.sha,
          branch
        })
      });

      results.push({
        file: file.name,
        status: delResp.status,
        success: delResp.ok
      });

    } catch (err) {
      results.push({
        file: file.name,
        error: "Failed",
        details: err.message
      });
    }
  }

  return res.status(200).json({
    success: true,
    type: "project",
    uid,
    promptId,
    total: results.length,
    results
  });
}
