import fetch from "node-fetch";
import sharp from "sharp";

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

function isValidSegment(val) {
  return val && /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(ip)) return res.status(429).json({ error: "Too many requests" });

  const { uid, promptId, imageUrl } = req.body;

  if (!isValidSegment(uid) || !isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid uid/promptId" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const imgResp = await fetch(imageUrl);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  const compressed = await sharp(buffer).webp({ quality: 80 }).toBuffer();

  const filename = `${Date.now()}.webp`;

  // ✅ NEW STORAGE PATH
  const githubPath = `storage/${uid}/${promptId}/${filename}`;

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const encoded = githubPath.split("/").map(encodeURIComponent).join("/");

  const putResp = await fetch(`${base}/${encoded}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: "upload image",
      content: compressed.toString("base64"),
      branch
    })
  });

  const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${githubPath}`;

  res.status(201).json({ success: true, filename, cdnUrl });
}
