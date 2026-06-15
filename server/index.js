import http from "http";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { loadPredictionModels, registerApiRoutes } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 5173;
const isProduction = process.env.NODE_ENV === "production";

async function startServer() {
    await loadPredictionModels();

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "50mb" }));

    registerApiRoutes(app);

    const httpServer = http.createServer(app);

    if (isProduction) {
        const distDir = path.join(ROOT, "dist");
        app.use(express.static(distDir));
    } else {
        const vite = await createViteServer({
            configFile: path.join(ROOT, "vite.config.js"),
            server: {
                middlewareMode: true,
                hmr: { server: httpServer },
            },
            appType: "mpa",
        });
        app.use(vite.middlewares);
    }

    httpServer.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
