import puppeteer from "puppeteer";
import { LRUCache } from "lru-cache";
import ort from "onnxruntime-node";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FILES_DIR = path.join(ROOT, "public", "files");
const MODELS_DIR = path.join(ROOT, "prediction", "models");

const predictionSessions = {};

export async function loadPredictionModels() {
    console.log(`[Server] Searching for models in: ${MODELS_DIR}`);

    try {
        const model_files = fs.readdirSync(MODELS_DIR).filter((file) => file.endsWith(".onnx"));
        if (model_files.length === 0) {
            console.warn("[Model Loader] No .onnx models found in prediction/models.");
            return;
        }

        for (const file_name of model_files) {
            const parts = file_name.replace(".onnx", "").split("-");
            if (parts.length < 3) {
                console.warn(`[Model Loader] Skipping invalid filename format: ${file_name}`);
                continue;
            }
            const model_key = `${parts[0]}-${parts[1]}`;
            const model_path = path.join(MODELS_DIR, file_name);

            try {
                const session = await ort.InferenceSession.create(model_path);
                predictionSessions[model_key] = session;
                console.log(`[Model Loader] Loaded model: ${model_key}`);
            } catch (error) {
                console.error(`[Model Loader] Failed to load ${file_name}:`, error);
            }
        }
    } catch (error) {
        console.error("[Model Loader] Could not read models directory.", error);
    }
}

const htmlCache = new LRUCache({
    max: 300,
    ttl: 60 * 60 * 1000 * 24,
});

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[char]);
}

function stripEventDistance(title) {
    return String(title ?? "").replace(/^\d+M\s+/, "");
}

function summarizeSeedingReport(report) {
    let groups = 0;
    let events = 0;
    let entries = 0;

    for (const gender of report.genders || []) {
        groups += (gender.groups || []).length;
        for (const group of gender.groups || []) {
            events += (group.events || []).length;
            for (const event of group.events || []) {
                entries += (event.entries || []).length;
            }
        }
    }

    return { groups, events, entries };
}

function pdfText(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
}

function truncateText(value, limit) {
    const text = String(value ?? "");
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1))}.`;
}

function compactName(value) {
    const parts = String(value ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || "";
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function createPdfDocument(pageContents) {
    const objects = [];
    const addObject = (body) => {
        objects.push(body);
        return objects.length;
    };

    const catalogId = addObject("placeholder");
    const pagesId = addObject("placeholder");
    const fontId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const pageIds = [];

    for (const content of pageContents) {
        const contentBuffer = Buffer.from(content, "latin1");
        const contentId = addObject(`<< /Length ${contentBuffer.length} >>\nstream\n${content}\nendstream`);
        const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
        pageIds.push(pageId);
    }

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((body, index) => {
        offsets.push(Buffer.byteLength(pdf, "latin1"));
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i++) {
        pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
}

function buildSeedingReportPdf(report) {
    const theme = {
        bg1: [1, 1, 1],
        bg2: [0.98, 0.98, 0.98],
        str2: [0.894, 0.894, 0.894],
        txt1: [0, 0, 0],
        txt2: [0.267, 0.267, 0.267],
    };
    const width = 595;
    const height = 842;
    const margin = 22;
    const pages = [];
    let ops = [];
    let y = margin;

    const color = (rgb, op) => `${rgb.join(" ")} ${op}`;
    const py = (topY) => height - topY;
    const add = (line) => ops.push(line);
    const setFill = (rgb) => add(color(rgb, "rg"));
    const setStroke = (rgb) => add(color(rgb, "RG"));
    const rect = (x, topY, w, h, fill = false, stroke = true) => {
        if (fill && stroke) add(`${x.toFixed(2)} ${(height - topY - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re B`);
        else if (fill) add(`${x.toFixed(2)} ${(height - topY - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
        else add(`${x.toFixed(2)} ${(height - topY - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    };
    const text = (value, x, topY, size = 8, rgb = theme.txt1) => {
        setFill(rgb);
        add(`BT /F1 ${size.toFixed(2)} Tf ${x.toFixed(2)} ${py(topY).toFixed(2)} Td (${pdfText(value)}) Tj ET`);
    };
    const line = (x1, topY1, x2, topY2) => {
        add(`${x1.toFixed(2)} ${py(topY1).toFixed(2)} m ${x2.toFixed(2)} ${py(topY2).toFixed(2)} l S`);
    };
    const newPage = () => {
        if (ops.length) pages.push(ops.join("\n"));
        ops = [];
        y = margin;
        setStroke(theme.str2);
        add("0.6 w");
    };
    const ensure = (neededHeight) => {
        if (y + neededHeight > height - margin) newPage();
    };
    const eventHeight = (event) => 35 + Math.max(1, (event.entries || []).length) * 11 + (event.type === "relay" && event.entries?.[0]?.relayTime ? 10 : 0);
    const drawEvent = (event, x, topY, w, h) => {
        setFill(theme.bg1);
        setStroke(theme.str2);
        rect(x, topY, w, h, true, true);
        setFill(theme.bg2);
        setStroke(theme.str2);
        rect(x, topY, w, 24, true, true);
        text(truncateText(stripEventDistance(event.title), 21), x + 4, topY + 8, 7.8, theme.txt1);
        text(`${report.teamAbr} ${Number(event.score?.ours || 0)} - ${Number(event.score?.theirs || 0)} ${report.opponentAbr}`, x + 4, topY + 18, 6.8, theme.txt2);

        const laneW = 17;
        const seedW = 33;
        const ptsW = 18;
        const nameW = w - laneW - seedW - ptsW - 8;
        let rowY = topY + 34;
        text("Ln", x + 4, rowY - 3, 5.8, theme.txt2);
        text(event.type === "relay" ? "Leg" : "Swimmer", x + laneW + 4, rowY - 3, 5.8, theme.txt2);
        text("Seed", x + laneW + nameW + 4, rowY - 3, 5.8, theme.txt2);
        text("Pts", x + laneW + nameW + seedW + 5, rowY - 3, 5.8, theme.txt2);
        line(x, rowY + 2, x + w, rowY + 2);
        rowY += 11;

        const entries = event.entries || [];
        if (entries.length === 0) {
            text("No entries", x + 4, rowY, 7, theme.txt2);
        } else {
            for (const entry of entries) {
                text(entry.lane, x + 6, rowY, 7, theme.txt1);
                const name = event.type === "relay"
                    ? `${truncateText(entry.stroke, 3)} ${compactName(entry.name)}`
                    : `${compactName(entry.name)}${entry.swimUp ? " up" : ""}`;
                text(truncateText(name, event.type === "relay" ? 10 : 9), x + laneW + 4, rowY, 6.9, theme.txt1);
                text(truncateText(entry.time, 8), x + laneW + nameW + 4, rowY, 6.9, theme.txt1);
                text(entry.points, x + laneW + nameW + seedW + 8, rowY, 6.9, theme.txt1);
                rowY += 11;
            }
        }

        if (event.type === "relay" && event.entries?.[0]?.relayTime) {
            setFill(theme.bg2);
            rect(x, topY + h - 10, w, 10, true, false);
            text(`Relay ${event.entries[0].relayTime}`, x + w - 48, topY + h - 3, 6.4, theme.txt2);
        }
    };
    const drawHeader = () => {
        text(`${report.team || ""} Seeding Report`, margin, y + 4, 17, theme.txt1);
        text(`${report.teamAbr || ""} vs ${report.opponent || ""} (${report.opponentAbr || ""})`, margin, y + 18, 8.5, theme.txt2);
        text(report.location === "away" ? "Away meet lanes 4, 2, 6" : "Home meet lanes 3, 5, 1", width - 162, y + 6, 8.5, theme.txt2);
        text(`Generated ${report.generated || ""}`, width - 162, y + 18, 7.5, theme.txt2);
        setStroke(theme.str2);
        line(margin, y + 27, width - margin, y + 27);
        y += 38;
    };

    newPage();
    drawHeader();

    for (const [genderIndex, gender] of (report.genders || []).entries()) {
        if (genderIndex > 0) {
            newPage();
            drawHeader();
        }

        ensure(26);
        text(gender.gender, margin, y, 14, theme.txt1);
        text(`${report.teamAbr || ""} ${Number(gender.total?.ours || 0)} - ${Number(gender.total?.theirs || 0)} ${report.opponentAbr || ""}`, width - 132, y, 10, theme.txt2);
        y += 16;
        setStroke(theme.str2);
        line(margin, y, width - margin, y);
        y += 10;

        for (const group of gender.groups || []) {
            const events = group.events || [];
            const chunks = [];
            for (let i = 0; i < events.length; i += 5) chunks.push(events.slice(i, i + 5));

            for (const [chunkIndex, chunk] of chunks.entries()) {
                const maxH = Math.max(55, ...chunk.map(eventHeight));
                ensure(25 + maxH);
                if (chunkIndex === 0) {
                    text(group.title, margin, y, 10.5, theme.txt1);
                    text(`Age group score: ${report.teamAbr || ""} ${Number(group.score?.ours || 0)} - ${Number(group.score?.theirs || 0)} ${report.opponentAbr || ""}`, width - 185, y, 8.4, theme.txt2);
                    y += 13;
                }

                const gap = 5;
                const cardW = (width - margin * 2 - gap * 4) / 5;
                chunk.forEach((event, index) => drawEvent(event, margin + index * (cardW + gap), y, cardW, maxH));
                y += maxH + 10;
            }
        }
    }

    if (ops.length) pages.push(ops.join("\n"));
    return createPdfDocument(pages);
}

export function registerApiRoutes(app) {
    app.get("/api/fetch-html", async (req, res) => {
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
        } catch {
            return res.status(400).send("Invalid URL format");
        }

        const cache_key = validated_url.toString();
        const cached_html = htmlCache.get(cache_key);

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
            htmlCache.set(cache_key, html);
            return res.setHeader("Content-Type", "text/html").status(200).send(html);
        } catch (error) {
            console.error(`[Server Error] Fetching ${cache_key} failed: ${error.message}`);
            return res.sendStatus(500);
        }
    });

    app.post("/api/predict", async (req, res) => {
        try {
            const { stroke_to_predict, gender, profiles } = req.body;

            if (!stroke_to_predict || !gender || !profiles || !Array.isArray(profiles)) {
                return res.status(400).json({
                    error: "Request body must include 'stroke_to_predict', 'gender', and an array of 'profiles'.",
                });
            }
            if (profiles.length === 0) return res.json({ predictions: [] });

            const model_key = `${stroke_to_predict}-${gender}`;
            const session = predictionSessions[model_key];

            if (!session) {
                return res.status(404).json({ error: `Model not found for criteria: '${model_key}'.` });
            }

            const feature_columns = [
                "free_25m_best", "free_25m_avg", "free_25m_std", "free_25m_count",
                "back_25m_best", "back_25m_avg", "back_25m_std", "back_25m_count",
                "breast_25m_best", "breast_25m_avg", "breast_25m_std", "breast_25m_count",
                "fly_25m_best", "fly_25m_avg", "fly_25m_std", "fly_25m_count",
            ];

            const batch_size = profiles.length;
            const feature_data = [];

            for (const profile of profiles) {
                const profile_features = feature_columns.map((feature_name) =>
                    profile[feature_name] !== undefined ? profile[feature_name] : -1
                );
                feature_data.push(...profile_features);
            }

            const input_data = Float32Array.from(feature_data);
            const input_tensor = new ort.Tensor("float32", input_data, [batch_size, 16]);

            const results = await session.run({ float_input: input_tensor });
            const predictions = Array.from(results.variable.data);

            return res.json({ predictions });
        } catch (error) {
            console.error("[Prediction Error]", error);
            return res.status(500).json({ error: "An internal server error occurred during prediction." });
        }
    });

    app.post("/api/render-pdf", async (req, res) => {
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
                width: "8.5in",
                height: "11in",
                margin: { top: "0.2in", bottom: "0.2in", left: "0.2in", right: "0.2in" },
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

    app.post("/api/seeding-report-pdf", async (req, res) => {
        const requestId = Math.random().toString(36).slice(2, 10);
        const { report } = req.body;

        if (!report || typeof report !== "object" || !Array.isArray(report.genders)) {
            console.warn(`[Seeding Report ${requestId}] Invalid payload`);
            return res.status(400).json({
                error: "Bad Request - Missing or invalid report data",
                requestId,
            });
        }

        try {
            const summary = summarizeSeedingReport(report);
            console.log(`[Seeding Report ${requestId}] Building ${report.teamAbr || "team"} vs ${report.opponentAbr || "opponent"} (${report.location || "unknown"}): ${summary.groups} groups, ${summary.events} events, ${summary.entries} entries`);
            const pdfBuffer = buildSeedingReportPdf(report);

            const filename = `${report.teamAbr || "team"}-${report.opponentAbr || "opponent"}-seeding-report.pdf`
                .toLowerCase()
                .replace(/[^a-z0-9.-]+/g, "-");

            res.set({
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename=${filename}`,
                "X-Seeding-Report-Request-Id": requestId,
            });
            console.log(`[Seeding Report ${requestId}] Built ${pdfBuffer.length} bytes`);
            res.send(pdfBuffer);
        } catch (error) {
            console.error(`[Seeding Report ${requestId}] Failed:`, error);
            res.status(500).json({
                error: "Error generating seeding report PDF",
                detail: error.message,
                requestId,
            });
        }
    });

    app.post("/api/save-json", async (req, res) => {
        try {
            const { data, filename: rawFilename } = req.body;

            if (!data) {
                return res.status(400).json({ success: false, error: "Invalid JSON data" });
            }

            let filename = (rawFilename ?? "data.json").replace(/[^a-zA-Z0-9._-]/g, "");
            if (!filename) filename = "data.json";

            if (!fs.existsSync(FILES_DIR)) {
                fs.mkdirSync(FILES_DIR, { recursive: true });
            }

            const filepath = path.join(FILES_DIR, filename);
            const jsonString = JSON.stringify(data, null, 2);
            const size = fs.writeFileSync(filepath, jsonString);

            return res.json({
                success: true,
                message: "File saved successfully",
                filename,
                path: `files/${filename}`,
                size,
            });
        } catch (error) {
            console.error("[Save JSON Error]", error);
            return res.status(500).json({ success: false, error: error.message });
        }
    });
}
