import fetch from "node-fetch";
import sharp from "sharp";

// Rate limiting
const rateLimiter = new Map();

function checkRateLimit(ip, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const userRequests = rateLimiter.get(ip) || [];
  const recentRequests = userRequests.filter((t) => now - t < windowMs);
  if (recentRequests.length >= limit) return false;
  recentRequests.push(now);
  rateLimiter.set(ip, recentRequests);
  return true;
}

// Validate uid / promptId (alphanumeric + dash + underscore only)
function isValidSegment(val) {
  if (!val || typeof val !== "string") return false;
  return /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

// Supported image MIME types accepted as input
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/**
 * POST /api/image-store
 *
 * Body (multipart OR JSON with base64):
 *   uid        – user identifier
 *   promptId   – prompt / asset identifier
 *   imageUrl   – remote image URL to fetch & compress   (option A)
 *   imageBase64– raw base64 image data                  (option B)
 *   mimeType   – required when using imageBase64
 *   quality    – JPEG/WebP quality 1-100 (default 80)
 *   format     – output format: jpeg | webp | png (default webp)
 *
 * Returns:
 *   { success, githubPath, rawUrl, cdnUrl }
 */
export default async function handler(req, res) {
  // ── Security headers ──────────────────────────────────────────────────────
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed", allowed: ["POST"] });

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
    console.error("GITHUB_TOKEN not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  // ── Parse body ────────────────────────────────────────────────────────────
  const {
    uid,
    promptId,
    imageUrl,
    imageBase64,
    mimeType,
    quality = 80,
    format = "webp",
  } = req.body || {};

  // ── Validate params ───────────────────────────────────────────────────────
  if (!isValidSegment(uid))
    return res.status(400).json({ error: "Invalid or missing uid" });

  if (!isValidSegment(promptId))
    return res.status(400).json({ error: "Invalid or missing promptId" });

  if (!imageUrl && !imageBase64)
    return res.status(400).json({ error: "Provide either imageUrl or imageBase64" });

  const outputFormat = ["jpeg", "webp", "png"].includes(format) ? format : "webp";
  const outputQuality = Math.min(100, Math.max(1, Number(quality) || 80));

  // ── Acquire raw image buffer ──────────────────────────────────────────────
  let rawBuffer;
  let sourceMime;

  try {
    if (imageUrl) {
      // Validate URL (only http/https)
      let parsedUrl;
      try {
        parsedUrl = new URL(imageUrl);
      } catch {
        return res.status(400).json({ error: "Invalid imageUrl" });
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res.status(400).json({ error: "imageUrl must use http or https" });
      }

      const imgResp = await fetch(imageUrl, {
        timeout: 20000,
        headers: { "User-Agent": "PromoraDB-ImageStore/1.0" },
      });

      if (!imgResp.ok) {
        return res
          .status(400)
          .json({ error: `Failed to fetch image: HTTP ${imgResp.status}` });
      }

      sourceMime = imgResp.headers.get("content-type")?.split(";")[0].trim() || "";

      // Enforce max download size (10 MB)
      const contentLength = Number(imgResp.headers.get("content-length") || 0);
      if (contentLength > 10 * 1024 * 1024) {
        return res.status(413).json({ error: "Source image exceeds 10 MB limit" });
      }

      const chunks = [];
      let totalBytes = 0;
      for await (const chunk of imgResp.body) {
        totalBytes += chunk.length;
        if (totalBytes > 10 * 1024 * 1024) {
          return res.status(413).json({ error: "Source image exceeds 10 MB limit" });
        }
        chunks.push(chunk);
      }
      rawBuffer = Buffer.concat(chunks);
    } else {
      // imageBase64 path
      sourceMime = mimeType || "";
      if (!ALLOWED_MIME.has(sourceMime)) {
        return res.status(400).json({
          error: `Unsupported mimeType. Allowed: ${[...ALLOWED_MIME].join(", ")}`,
        });
      }

      rawBuffer = Buffer.from(imageBase64, "base64");
      if (rawBuffer.length > 10 * 1024 * 1024) {
        return res.status(413).json({ error: "Source image exceeds 10 MB limit" });
      }
    }
  } catch (err) {
    console.error("Image acquisition error:", err);
    return res.status(500).json({ error: "Failed to acquire image" });
  }

  // ── Compress / convert with sharp ─────────────────────────────────────────
  let compressedBuffer;
  let fileExt;

  try {
    const sharpInst = sharp(rawBuffer);

    if (outputFormat === "webp") {
      compressedBuffer = await sharpInst
        .webp({ quality: outputQuality, effort: 4 })
        .toBuffer();
      fileExt = "webp";
    } else if (outputFormat === "png") {
      compressedBuffer = await sharpInst
        .png({ compressionLevel: 8 })
        .toBuffer();
      fileExt = "png";
    } else {
      compressedBuffer = await sharpInst
        .jpeg({ quality: outputQuality, progressive: true })
        .toBuffer();
      fileExt = "jpg";
    }
  } catch (err) {
    console.error("Sharp compression error:", err);
    return res.status(500).json({ error: "Failed to process image" });
  }

  // ── Build GitHub path: uid/promptId/images/<timestamp>.<ext> ─────────────
  const timestamp = Date.now();
  const filename = `${timestamp}.${fileExt}`;
  const githubPath = `${uid}/${promptId}/images/${filename}`;

  // ── Check if file already exists (to get SHA for update) ─────────────────
  const owner_repo_base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const encodedPath = githubPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  let existingSha = null;
  try {
    const checkResp = await fetch(`${owner_repo_base}/${encodedPath}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "PromoraDB-ImageStore/1.0",
      },
    });
    if (checkResp.ok) {
      const existing = await checkResp.json();
      existingSha = existing.sha;
    }
  } catch {
    // If check fails, proceed as new file
  }

  // ── Upload to GitHub ──────────────────────────────────────────────────────
  const base64Content = compressedBuffer.toString("base64");
  const commitMessage = `Store image ${filename} for uid=${uid} promptId=${promptId}`;

  const putBody = {
    message: commitMessage,
    content: base64Content,
    branch,
    ...(existingSha && { sha: existingSha }),
  };

  let putResp;
  try {
    putResp = await fetch(`${owner_repo_base}/${encodedPath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "PromoraDB-ImageStore/1.0",
      },
      body: JSON.stringify(putBody),
      timeout: 30000,
    });
  } catch (err) {
    console.error("GitHub PUT error:", err);
    return res.status(500).json({ error: "Failed to upload image to GitHub" });
  }

  if (!putResp.ok) {
    const errBody = await putResp.json().catch(() => ({}));
    console.error("GitHub PUT failed:", putResp.status, errBody);
    return res.status(putResp.status).json({
      error: "GitHub upload failed",
      details: process.env.NODE_ENV === "development" ? errBody : undefined,
    });
  }

  const result = await putResp.json();

  // ── Build response URLs ───────────────────────────────────────────────────
  // raw.githubusercontent.com URL (direct binary, no API auth needed)
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${githubPath}`;

  // jsDelivr CDN – free, cached, globally fast (great for app use)
  const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${githubPath}`;

  return res.status(201).json({
    success: true,
    githubPath,
    rawUrl,
    cdnUrl,
    filename,
    uid,
    promptId,
    format: outputFormat,
    commit: {
      sha: result.commit?.sha,
      url: result.commit?.html_url,
    },
    size: {
      compressed: compressedBuffer.length,
    },
  });
}
