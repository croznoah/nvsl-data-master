import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
    root: "src",
    publicDir: resolve(__dirname, "public"),
    build: {
        outDir: resolve(__dirname, "dist"),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, "src/index.html"),
                setup: resolve(__dirname, "src/setup.html"),
                timer: resolve(__dirname, "src/timer/index.html"),
                sheet: resolve(__dirname, "src/sheet/index.html"),
                "prediction-demo": resolve(__dirname, "src/prediction/demo.html"),
                "prediction-profiles": resolve(__dirname, "src/prediction/profiles.html"),
                "prediction-swimmers": resolve(__dirname, "src/prediction/swimmers.html"),
            },
        },
    },
});
