import fetch from "node-fetch";

// ===============================
// 🔒 Rate Limiter
// ===============================
const rateLimiter = new Map();

function checkRateLimit(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const reqs = rateLimiter.get(ip) || [];
  const recent = reqs.filter(t => now - t < windowMs);

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

function isValidBase64(content) {
  return typeof content === "string" && content.length < 10 * 1024 * 1024;
}

// ===============================
// 🚀 Handler
// ===============================
export default async function handler(req, res) {

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Too many requests"
    });
  }

  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({
      error: "Missing GitHub token"
    });
  }

  const { uid, promptId, imageBase64 } = req.body;

  // ===============================
  // VALIDATION
  // ===============================
  if (!isValidSegment(uid) || !isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid uid/promptId" });
  }

  if (!isValidBase64(imageBase64)) {
    return res.status(400).json({ error: "Invalid image data" });
  }

  // Remove data prefix if exists
  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const filename = `${Date.now()}.webp`;
  const githubPath = `storage/${uid}/${promptId}/${filename}`;

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const encodedPath = githubPath.split("/").map(encodeURIComponent).join("/");

  try {

    // ===============================
    // CREATE FILE (NO UPDATE NEEDED)
    // ===============================
    const resp = await fetch(`${base}/${encodedPath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "PromoraDB"
      },
      body: JSON.stringify({
        message: `Upload ${filename}`,
        content: base64Data,
        branch
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({
        error: "GitHub upload failed",
        details: data
      });
    }

    const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${githubPath}`;

    return res.status(201).json({
      success: true,
      filename,
      path: githubPath,
      cdnUrl
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({
      error: "Internal server error",
      message: err.message
    });
  }
}
