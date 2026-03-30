import fetch from "node-fetch";

function isValidSegment(val) {
  return val && /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

export default async function handler(req, res) {

  if (req.method !== "DELETE") {
    return res.status(405).end();
  }

  const { uid, promptId, filename } = req.query;

  if (!isValidSegment(uid) || !isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid params" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;

  // ================= SINGLE DELETE =================
  if (filename) {
    const path = `storage/${uid}/${promptId}/${filename}`;
    const encoded = path.split("/").map(encodeURIComponent).join("/");

    const file = await fetch(`${base}/${encoded}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    });

    const data = await file.json();

    await fetch(`${base}/${encoded}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "delete file",
        sha: data.sha,
        branch
      })
    });

    return res.json({ success: true });
  }

  // ================= FULL DELETE =================
  const dir = `storage/${uid}/${promptId}`;
  const encoded = dir.split("/").map(encodeURIComponent).join("/");

  const list = await fetch(`${base}/${encoded}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  });

  const files = await list.json();

  for (const f of files) {
    await fetch(`${base}/${f.path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "delete",
        sha: f.sha,
        branch
      })
    });
  }

  res.json({ success: true });
}
