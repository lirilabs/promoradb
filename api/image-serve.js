import fetch from "node-fetch";

// Rate limiting
const rateLimiter = new Map();

function checkRateLimit(ip, limit = 120, windowMs = 60000) {
  const now = Date.now();
  const userRequests = rateLimiter.get(ip) || [];
  const recentRequests = userRequests.filter((t) => now - t < windowMs);
  if (recentRequests.length >= limit) return false;
  recentRequests.push(now);
  rateLimiter.set(ip, recentRequests);
  return true;
}

function isValidSegment(val) {
  if (!val || typeof val !== "string") return false;
  return /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

function isValidFilename(val) {
  if (!val || typeof val !== "string") return false;
  return /^[a-zA-Z0-9_\-\.]{1,255}$/.test(val);
}

const EXT_TO_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/**
 * GET /api/image-serve?uid=&promptId=&filename=
 *
 * Fetches the raw image bytes from GitHub and streams them back
 * with the correct Content-Type so apps can use the URL as an <img> src.
 *
 * Also supports listing: GET /api/image-serve?uid=&promptId=  (no filename)
 *   → returns JSON list of stored image URLs for that uid/promptId.
 */
export default async function handler(req, res) {
  // ── Security headers ──────────────────────────────────────────────────────
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed", allowed: ["GET"] });

  // ── Rate limit ────────────────────────────────────────────────────────────
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  // ── Env check ─────────────────────────────────────────────────────────────
  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const { uid, promptId, filename } = req.query;

  if (!isValidSegment(uid))
    return res.status(400).json({ error: "Invalid or missing uid" });
  if (!isValidSegment(promptId))
    return res.status(400).json({ error: "Invalid or missing promptId" });

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const cdnBase = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}`;

  // ────────────────────────────────────────────────────────────────────────
  // LIST MODE – return all images for uid/promptId
  // ────────────────────────────────────────────────────────────────────────
  if (!filename) {
    const dirPath = `${uid}/${promptId}/images`;
    const encodedDir = dirPath.split("/").map(encodeURIComponent).join("/");

    const listResp = await fetch(`${base}/${encodedDir}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "PromoraDB-ImageStore/1.0",
      },
    }).catch(() => null);

    if (!listResp || !listResp.ok) {
      if (listResp?.status === 404) {
        return res.status(200).json({ uid, promptId, images: [] });
      }
      return res.status(listResp?.status || 500).json({ error: "Failed to list images" });
    }

    const files = await listResp.json();
    const images = files
      .filter((f) => f.type === "file")
      .map((f) => ({
        filename: f.name,
        githubPath: f.path,
        rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path}`,
        cdnUrl: `${cdnBase}/${f.path}`,
        size: f.size,
        sha: f.sha,
      }));

    return res.status(200).json({ uid, promptId, images });
  }

  // ────────────────────────────────────────────────────────────────────────
  // SERVE MODE – proxy the image bytes back as the correct image type
  // ────────────────────────────────────────────────────────────────────────
  if (!isValidFilename(filename)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const githubPath = `${uid}/${promptId}/images/${filename}`;
  const encodedPath = githubPath.split("/").map(encodeURIComponent).join("/");

  // Fetch via raw URL (no base64 decoding overhead for binary)
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${githubPath}`;

  let imgResp;
  try {
    imgResp = await fetch(rawUrl, {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "PromoraDB-ImageStore/1.0",
      },
      timeout: 15000,
    });
  } catch (err) {
    console.error("GitHub raw fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch image from storage" });
  }

  if (!imgResp.ok) {
    if (imgResp.status === 404)
      return res.status(404).json({ error: "Image not found" });
    return res.status(imgResp.status).json({ error: "Failed to retrieve image" });
  }

  // Determine MIME from extension
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const mime = EXT_TO_MIME[ext] || "application/octet-stream";

  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader(
    "CDN-URL",
    `${cdnBase}/${uid}/${promptId}/images/${filename}`
  );

  // Stream the response
  imgResp.body.pipe(res);
}
