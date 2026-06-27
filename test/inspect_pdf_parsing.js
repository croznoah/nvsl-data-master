import puppeteer from "puppeteer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testPdf(pdfPath) {
    console.log(`\n==================================================`);
    console.log(`Testing PDF: ${path.basename(pdfPath)}`);
    console.log(`==================================================`);

    // Start dev server
    const serverProcess = spawn("npm", ["run", "dev"], {
        cwd: ROOT,
        env: { ...process.env, PORT: "6173" }
    });

    serverProcess.stdout.on("data", (data) => {
        // console.log(`[Server] ${data.toString().trim()}`);
    });
    serverProcess.stderr.on("data", (data) => {
        console.error(`[Server Error] ${data.toString().trim()}`);
    });

    // Wait for server to start
    await wait(2000);

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    try {
        const page = await browser.newPage();
        
        // Forward page logs
        page.on("console", msg => {
            console.log(`[Browser Console] ${msg.text()}`);
        });

        page.on("pageerror", err => {
            console.error(`[Browser Page Error] ${err.toString()}`);
        });

        await page.goto("http://localhost:6173/sheet/index.html", { waitUntil: "networkidle0" });
        console.log("Page loaded. Uploading file...");

        const startTime = Date.now();
        const inputElement = await page.$("input[type=file]");
        await inputElement.uploadFile(pdfPath);

        // Wait for page to process PDF
        console.log("Waiting for processing...");
        let attempts = 0;
        let success = false;
        while (attempts < 60) {
            await wait(1000);
            
            const state = await page.evaluate(() => {
                return {
                    hasSheetData: typeof window.sheet_data !== "undefined" && window.sheet_data !== null,
                    sheetDataLength: window.sheet_data ? window.sheet_data.length : 0,
                    title: window.sheet_title,
                    subtitle: document.querySelector(".sheet-subtitle")?.innerText,
                    pdfOutputVisible: document.getElementById("pdf-output")?.style.display === "grid",
                    pdfOutputHtml: document.getElementById("pdf-output")?.innerHTML?.substring(0, 1000),
                    extractedtxt: typeof window.extractedtxt !== "undefined" ? window.extractedtxt : null
                };
            });

            if (state.hasSheetData && state.sheetDataLength > 0) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`Parsed successfully in ${duration}s! Title: ${state.title}`);
                console.log(`Found ${state.sheetDataLength} events.`);
                
                // Get full sheet data
                const fullData = await page.evaluate(() => window.sheet_data);
                
                // Save parsed data to tmp
                const outName = path.basename(pdfPath, ".pdf") + ".parsed.json";
                const outPath = path.join(ROOT, "tmp", outName);
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fs.writeFileSync(outPath, JSON.stringify(fullData, null, 2), "utf8");
                console.log(`Saved JSON output to: ${outPath}`);
                
                success = true;
                break;
            } else {
                console.log(`Waiting... Status text: "${state.subtitle || 'none'}"`);
                if (state.subtitle && state.subtitle.includes("failed")) {
                    console.log("Parsing reported failure.");
                    break;
                }
            }
            attempts++;
        }

        if (!success) {
            throw new Error(`Failed to parse PDF: ${path.basename(pdfPath)}`);
        }

    } finally {
        await browser.close();
        serverProcess.kill();
        // Give it a moment to release the port
        await wait(1000);
    }
}

async function run() {
    try {
        const fairfaxPdf = path.join(ROOT, "src", "sheet", "Fairfax Heat Sheet with Times.pdf");
        const ravensworthPdf = path.join(ROOT, "src", "sheet", "A Meet_ Parklawn @ Ravensworth 06_27_2026 Meet-Sheet With Times.pdf");
        
        // Test Fairfax (should trigger OCR fallback and parse correctly)
        await testPdf(fairfaxPdf);
        
        // Test Ravensworth (should use fast direct text-layer parsing)
        await testPdf(ravensworthPdf);
        
        console.log("\nALL TESTS PASSED SUCCESSFULLY!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

run();
