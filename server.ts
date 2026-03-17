import express from "express";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import path from "path";

const isProd = process.env.NODE_ENV === "production";

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json());

  // Vite middleware for development
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve("dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve("dist/index.html"));
    });
  }

  const PORT = 3000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
