import fetch from "node-fetch";

function isValidSegment(val) {
  return val && /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*");

  const { uid, promptId, filename } = req.query;

  if (!isValidSegment(uid) || !isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid params" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;

  // ================= LIST =================
  if (!filename) {
    const dirPath = `storage/${uid}/${promptId}`;
    const encoded = dirPath.split("/").map(encodeURIComponent).join("/");

    const resp = await fetch(`${base}/${encoded}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    });

    if (!resp.ok) return res.json({ images: [] });

    const files = await resp.json();

    const images = files.map(f => ({
      filename: f.name,
      cdnUrl: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${f.path}`
    }));

    return res.json({ images });
  }

  // ================= VIEW =================
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/storage/${uid}/${promptId}/${filename}`;
  res.redirect(rawUrl);
}
