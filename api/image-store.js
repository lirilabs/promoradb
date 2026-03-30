import fetch from "node-fetch";
import sharp from "sharp";
import Busboy from "busboy";

export const config = {
  api: { bodyParser: false },
};

function isValidSegment(val) {
  return val && /^[a-zA-Z0-9_\-]{1,128}$/.test(val);
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  if (!process.env.GITHUB_TOKEN) {
    return res.status(500).json({ error: "Missing GitHub token" });
  }

  const owner = process.env.GITHUB_OWNER || "lirilabs";
  const repo = process.env.GITHUB_REPO || "promoradb";
  const branch = process.env.GITHUB_BRANCH || "main";

  const busboy = Busboy({ headers: req.headers });

  let uid, promptId;
  let buffer = Buffer.alloc(0);

  await new Promise((resolve, reject) => {

    busboy.on("field", (name, val) => {
      if (name === "uid") uid = val;
      if (name === "promptId") promptId = val;
    });

    busboy.on("file", (name, file) => {
      file.on("data", (data) => {
        buffer = Buffer.concat([buffer, data]);
      });
    });

    busboy.on("finish", resolve);
    busboy.on("error", reject);

    req.pipe(busboy);
  });

  if (!isValidSegment(uid) || !isValidSegment(promptId)) {
    return res.status(400).json({ error: "Invalid uid/promptId" });
  }

  if (!buffer.length) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const compressed = await sharp(buffer)
    .webp({ quality: 80 })
    .toBuffer();

  const filename = `${Date.now()}.webp`;
  const githubPath = `storage/${uid}/${promptId}/${filename}`;

  const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
  const encoded = githubPath.split("/").map(encodeURIComponent).join("/");

  const putResp = await fetch(`${base}/${encoded}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Upload ${filename}`,
      content: compressed.toString("base64"),
      branch,
    }),
  });

  if (!putResp.ok) {
    return res.status(500).json({ error: "Upload failed" });
  }

  const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${githubPath}`;

  return res.status(201).json({
    success: true,
    filename,
    cdnUrl,
  });
}
