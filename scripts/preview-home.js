#!/usr/bin/env node
// Local, read-only layout preview. It never loads .env, index.js, or saved event data.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function isolatePreviewEnvironment() {
    // Keep the standalone preview independent of any app credentials in the shell.
    const inheritedPath = process.env.PATH;
    for (const key of Object.keys(process.env)) delete process.env[key];
    if (inheritedPath) process.env.PATH = inheritedPath;
    process.env.NODE_ENV = "development";
}

const assetsDir = path.resolve(__dirname, "../assets");
const HOST = "127.0.0.1";
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

const fixtureSettings = Object.freeze({
    eventName: "DEMO EVENT",
    languageMode: "en",
    maxPrints: 2,
    maxConcurrentGeneration: 3,
    queuePaused: false,
    enablePrinting: true,
    reviewMode: "human",
    boothDisplayMode: "video",
    boothShowSms: true,
    twilioPhoneNumber: "+14155550199",
    boothShowWhatsapp: false,
    modelOrchestrator: "gpt-5.5",
    modelVisionLight: "gpt-5.4-nano",
    modelImageGen: "gpt-image-2-2026-04-21",
    modelSmartReply: "gpt-5.4-nano",
    modelRefAnalysis: "gpt-5.5",
    voiceReadinessIssues: ["Voice number must be E.164", "Public HTTPS BASE_URL is required"],
    credentialStatus: {
        openaiApiKey: { configured: true, last4: "0000" },
        twilioAuthToken: { configured: true },
        dubApiKey: { configured: false },
        printRelayKey: { configured: false },
        reviewPin: { configured: true },
    },
});
const fixtureFiles = Object.freeze({
    events: ["DEMO EVENT", "SECOND DEMO EVENT"],
    eventProfiles: ["DEMO EVENT"],
    printers: [], templates: [], videos: [],
    brandReferences: [], styleReferences: [], backgroundReferences: [],
});

function send(response, status, body, contentType) {
    response.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
}

function sendJson(response, status, value) {
    send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function serveAsset(response, pathname) {
    let relative;
    try { relative = decodeURIComponent(pathname.slice("/assets/".length)); }
    catch { return send(response, 400, "Bad asset path", "text/plain; charset=utf-8"); }
    const fullPath = path.resolve(assetsDir, relative);
    if (!fullPath.startsWith(assetsDir + path.sep)) {
        return send(response, 404, "Not found", "text/plain; charset=utf-8");
    }
    try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new Error("not a file");
        send(response, 200, fs.readFileSync(fullPath), contentTypes[path.extname(fullPath).toLowerCase()] || "application/octet-stream");
    } catch {
        send(response, 404, "Not found", "text/plain; charset=utf-8");
    }
}

function createPreviewServer() {
    const { buildHomeHtml, buildSettingsHtml } = require("../lib/home");
    return http.createServer((request, response) => {
        let pathname;
        try { pathname = new URL(request.url, `http://${HOST}`).pathname; }
        catch { return send(response, 400, "Bad request", "text/plain; charset=utf-8"); }
        if (request.method !== "GET") {
            return sendJson(response, 405, { error: "This is a read-only demo preview. No changes were saved." });
        }
        if (pathname === "/" || pathname === "/home") {
            response.writeHead(302, { Location: "/home/", "Cache-Control": "no-store" });
            return response.end();
        }
        if (pathname === "/home/") {
            return send(response, 200, buildHomeHtml({ demo: true, getSetting: (key) => fixtureSettings[key] }), "text/html; charset=utf-8");
        }
        if (pathname === "/home/settings") {
            return send(response, 200, buildSettingsHtml({ demo: true }), "text/html; charset=utf-8");
        }
        if (pathname.startsWith("/assets/")) return serveAsset(response, pathname);
        if (pathname === "/dashboard/api/settings") return sendJson(response, 200, fixtureSettings);
        if (pathname === "/dashboard/api/settings/files") return sendJson(response, 200, fixtureFiles);
        if (pathname === "/dashboard/api/review-count") return sendJson(response, 200, { count: 2 });
        if (pathname === "/dashboard/api/style-preview") return sendJson(response, 200, { image: null });
        if (pathname === "/dashboard/api/openai-models") {
            return sendJson(response, 200, { source: "fixture", models: { text: ["gpt-5.4-nano"], vision: ["gpt-5.5"], image: ["gpt-image-2-2026-04-21"] } });
        }
        if (pathname === "/auth/me") return sendJson(response, 200, { name: "Demo operator" });
        if (pathname === "/dashboard/api/staff-qr") {
            return send(response, 200, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="white"/><rect x="12" y="12" width="136" height="136" fill="none" stroke="#EF223A" stroke-width="2"/><text x="80" y="82" text-anchor="middle" fill="#000D25" font-family="sans-serif" font-size="20" font-weight="bold">DEMO</text></svg>', "image/svg+xml");
        }
        return send(response, 404, "Only Home and Settings are available in this demo preview.", "text/plain; charset=utf-8");
    });
}

if (require.main === module) {
    isolatePreviewEnvironment();
    const port = Number(process.argv[2] || 4173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("Usage: node scripts/preview-home.js [port]");
        process.exitCode = 1;
    } else {
        createPreviewServer().listen(port, HOST, () => {
            console.log(`Read-only demo preview: http://${HOST}:${port}/home/`);
            console.log(`Settings: http://${HOST}:${port}/home/settings`);
            console.log("Sample data only. No .env, saved events, queue processors, or external services.");
        });
    }
}

module.exports = { createPreviewServer, fixtureSettings };
