#!/usr/bin/env node
"use strict";

// Offline audit cleanup. Run without --apply to preview first. Stop all app
// revisions that can write the file before applying, including overlapping
// Azure revisions sharing the same data mount. No credential values are shown.

const { inspectLegacyAuditLogFile, migrateLegacyAuditLogFile } = require("../lib/audit");

function usage() {
    return [
        "Usage: node scripts/redact-audit-log.js --file /absolute/path/to/audit-log.jsonl [--apply]",
        "Without --apply: report how many entries need redaction; do not change the file.",
        "With --apply: atomically rewrite the file after all writers have stopped.",
    ].join("\n");
}

async function main(args) {
    if (args.length === 1 && args[0] === "--help") {
        console.log(usage());
        return;
    }
    const fileIndex = args.indexOf("--file");
    const apply = args.includes("--apply");
    if (fileIndex < 0 || !args[fileIndex + 1]
        || args.some((arg, index) => arg !== "--file" && arg !== "--apply" && index !== fileIndex + 1)
        || args.filter((arg) => arg === "--file").length !== 1
        || args.filter((arg) => arg === "--apply").length > 1) {
        throw new Error(usage());
    }
    const filePath = args[fileIndex + 1];
    const preview = await inspectLegacyAuditLogFile(filePath);
    console.log(`${preview.redactedEntries} of ${preview.totalEntries} entries need redaction`);
    if (!apply) return;
    const result = await migrateLegacyAuditLogFile(filePath);
    console.log(`redacted ${result.redactedEntries} of ${result.totalEntries} entries`);
}

main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
