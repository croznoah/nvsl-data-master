import puppeteer from "puppeteer";
import express from "express";
import cors from "cors";
import { LRUCache } from "lru-cache";
import ort from 'onnxruntime-node';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// --- 1. Set up Express App and Initial Config ---
const app = express();
const port = 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// This object will act as a cache for all loaded ONNX models.
const predictionSessions = {};

/**
 * Asynchronously loads all .onnx models from the /models directory into the cache.
 */
async function loadPredictionModels() {
    // The Python script saves models to a "models" directory inside its own "prediction" folder.
    const models_dir = path.join(__dirname, "prediction/models");
    console.log(`[Server] Searching for models in: ${models_dir}`);

    try {
        const model_files = fs.readdirSync(models_dir).filter(file => file.endsWith(".onnx"));
        if (model_files.length === 0) {
            console.warn("[Model Loader] ⚠️ No .onnx models found. Ensure they are in the 'models' directory.");
            return;
        }

        for (const file_name of model_files) {
            // Example: "free-boys-model.onnx" -> key: "free-boys"
            const parts = file_name.replace(".onnx", "").split('-');
            if (parts.length < 3) {
                 console.warn(`[Model Loader] Skipping invalid filename format: ${file_name}`);
                 continue;
            }
            // KEY CHANGE: The key is now just stroke-gender
            const model_key = `${parts[0]}-${parts[1]}`;
            const model_path = path.join(models_dir, file_name);

            try {
                const session = await ort.InferenceSession.create(model_path);
                predictionSessions[model_key] = session;
                console.log(`[Model Loader] ✅ Successfully loaded model for: ${model_key}`);
            } catch (error) {
                console.error(`[Model Loader] ❌ Failed to load model ${file_name}:`, error);
            }
        }
    } catch (error) {
        console.error("[Model Loader] ❌ Could not read models directory. Ensure it exists and check permissions.", error);
    }
}


// --- 2. Main async function to start the server ---
async function startServer() {
    // A. Load all ML models before starting the server
    await loadPredictionModels();

    // B. Set up Middleware and Caching
    app.use(cors());
    app.use(express.json());

    const cache = new LRUCache({
        max: 300,
        ttl: 60 * 60 * 1000 * 24,
    });

    // C. Define API Endpoints

    // Endpoint 1: HTML fetcher (unchanged)
    app.get("/fetch-html", async (req, res) => {
        const target_url = req.query.url;

        if (!target_url) {
            return res.status(400).send("Bad Request - Missing URL");
        }

        let validated_url;
        try {
            validated_url = new URL(target_url);
            if (!["http:", "https:"].includes(validated_url.protocol)) {
                return res.status(400).send("Invalid protocol");
            }
        } catch (_) {
            return res.status(400).send("Invalid URL format");
        }

        const cache_key = validated_url.toString();
        const cached_html = cache.get(cache_key);

        if (cached_html) {
            console.log(`[Cache] HIT for ${cache_key}`);
            return res.setHeader("Content-Type", "text/html").status(200).send(cached_html);
        }
        console.log(`[Cache] MISS for ${cache_key}`);

        try {
            const response = await fetch(cache_key);
            if (!response.ok) {
                console.warn(`[Origin Error] Fetch failed for ${cache_key} with status: ${response.status}.`);
                return res.sendStatus(response.status);
            }
            const html = await response.text();
            cache.set(cache_key, html);
            return res.setHeader("Content-Type", "text/html").status(200).send(html);
        } catch (error) {
            console.error(`[Server Error] Fetching ${cache_key} failed: ${error.message}`);
            return res.sendStatus(500);
        }
    });

    // Endpoint 2: The ML model predictor (REPLACED)
    app.post("/predict", async (req, res) => {
            try {
                const { stroke_to_predict, gender, profiles } = req.body;

                if (!stroke_to_predict || !gender || !profiles || !Array.isArray(profiles)) {
                    return res.status(400).json({ error: "Request body must include 'stroke_to_predict', 'gender', and an array of 'profiles'." });
                }
                if (profiles.length === 0) return res.json({ predictions: [] });

                const model_key = `${stroke_to_predict}-${gender}`;
                const session = predictionSessions[model_key];

                if (!session) {
                    return res.status(404).json({ error: `Model not found for criteria: '${model_key}'.` });
                }

                // --- KEY CHANGE: Define all 16 input features in the correct order ---
                const feature_columns = [
                    "free_25m_best", "free_25m_avg", "free_25m_std", "free_25m_count",
                    "back_25m_best", "back_25m_avg", "back_25m_std", "back_25m_count",
                    "breast_25m_best", "breast_25m_avg", "breast_25m_std", "breast_25m_count",
                    "fly_25m_best", "fly_25m_avg", "fly_25m_std", "fly_25m_count"
                ];

                const batch_size = profiles.length;
                const feature_data = [];

                // Iterate over each profile in the batch
                for (const profile of profiles) {
                    // For each profile, extract the 16 feature values in order
                    const profile_features = feature_columns.map(feature_name => {
                        return profile[feature_name] !== undefined ? profile[feature_name] : -1;
                    });
                    feature_data.push(...profile_features);
                }

                const input_data = Float32Array.from(feature_data);
                // The shape is [batch_size, num_features]. num_features is now 16.
                const input_tensor = new ort.Tensor("float32", input_data, [batch_size, 16]);

                const results = await session.run({ "float_input": input_tensor });
                const predictions = Array.from(results.variable.data);

                return res.json({ predictions });

            } catch (error) {
                console.error("[Prediction Error]", error);
                return res.status(500).json({ error: "An internal server error occurred during prediction." });
            }
        });

    // Endpoint 3: Render pdf for sheet analyzer (unchanged)
    app.post("/render-pdf", async (req, res) => {
        const { html } = req.body;

        if (!html || typeof html !== "string") {
            return res.status(400).send("Bad Request - Missing or invalid HTML");
        }

        try {
            const browser = await puppeteer.launch({
                headless: "new",
                args: ["--no-sandbox", "--disable-setuid-sandbox"],
            });
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: "networkidle0" });
            const pdfBuffer = await page.pdf({
                format: "A4",
                printBackground: true,
                width: '8.5in',
                height: '11in',
                margin: { top: "0.2in", bottom: "0.2in", left: "0.2in", right: "0.2in" }
            });
            await browser.close();

            res.set({
                "Content-Type": "application/pdf",
                "Content-Disposition": "attachment; filename=rendered.pdf",
            });
            res.send(pdfBuffer);
        } catch (error) {
            console.error(`[Puppeteer Error] Rendering failed: ${error.message}`);
            res.status(500).send("Error generating PDF");
        }
    });

    // --- D. Start Listening for Requests ---
    app.listen(port, () => {
        console.log(`🚀 Server listening at http://localhost:${port}`);
    });
}

// --- 3. Run the main async function ---
startServer();
