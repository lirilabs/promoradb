import fetch from "node-fetch";
import Busboy from "busboy";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {

  try {

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

    if (!buffer.length) {
      return res.status(400).json({ error: "No file" });
    }

    const filename = `${Date.now()}.webp`;
    const path = `storage/${uid}/${promptId}/${filename}`;

    const base = `https://api.github.com/repos/${owner}/${repo}/contents`;
    const encoded = path.split("/").map(encodeURIComponent).join("/");

    const resp = await fetch(`${base}/${encoded}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: "upload",
        content: buffer.toString("base64"),
        branch
      })
    });

    const data = await resp.json();

    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
