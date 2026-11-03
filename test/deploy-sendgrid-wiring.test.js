const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const template = fs.readFileSync(path.join(root, ".github/containerapp.yaml"), "utf8");
const names = [
    "SENDGRID_API_KEY",
    "SENDGRID_FROM_EMAIL",
    "SENDGRID_FROM_NAME",
    "SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY",
    "SENDGRID_REGION",
];

function runBlock(stepName) {
    const header = `      - name: ${stepName}\n`;
    const start = workflow.indexOf(header);
    assert.notEqual(start, -1, `Missing workflow step: ${stepName}`);
    const next = workflow.indexOf("\n      - name: ", start + header.length);
    const step = workflow.slice(start, next === -1 ? undefined : next);
    const runHeader = "        run: |\n";
    const runStart = step.indexOf(runHeader);
    assert.notEqual(runStart, -1, `Missing run block: ${stepName}`);
    return step.slice(runStart + runHeader.length)
        .split("\n")
        .map(line => line.startsWith("          ") ? line.slice(10) : line)
        .join("\n");
}

const validation = runBlock("Validate SendGrid configuration");
const setSecrets = runBlock("Set secrets");
const sendgridStart = setSecrets.indexOf("# Keep SendGrid optional.");
const sendgridEndMarker = '} >> "$GITHUB_ENV"';
const sendgridEnd = setSecrets.indexOf(sendgridEndMarker, sendgridStart);
assert.ok(sendgridStart >= 0 && sendgridEnd > sendgridStart, "Missing SendGrid secret sync block");
const secretSync = setSecrets.slice(sendgridStart, sendgridEnd + sendgridEndMarker.length)
    .replaceAll("${{ env.APP_NAME }}", "test-app")
    .replaceAll("${{ env.RESOURCE_GROUP }}", "test-group");

const deploy = runBlock("Deploy Container App");
const renderer = deploy.match(/python3 - \/tmp\/containerapp\.yaml <<'PY'\n([\s\S]*?)\nPY(?:\n|$)/)?.[1];
assert.ok(renderer, "Missing SendGrid YAML renderer");

function validate(key, email) {
    return spawnSync("bash", ["-e", "-c", validation], {
        encoding: "utf8",
        env: { ...process.env, SENDGRID_API_KEY: key, SENDGRID_FROM_EMAIL: email },
    });
}

function syncSecrets(settings) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendgrid-deploy-sync-"));
    const envFile = path.join(dir, "github-env");
    const argsFile = path.join(dir, "az-args");
    try {
        const stub = "az() { printf '%s\\n' \"$@\" > \"$AZ_ARGS_FILE\"; }\n";
        const result = spawnSync("bash", ["-e", "-c", stub + secretSync], {
            encoding: "utf8",
            env: {
                ...process.env,
                SENDGRID_API_KEY: settings.key || "",
                SENDGRID_FROM_EMAIL: settings.email || "",
                SENDGRID_FROM_NAME: settings.name || "",
                SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: settings.publicKey || "",
                SENDGRID_REGION: settings.region || "",
                GITHUB_ENV: envFile,
                AZ_ARGS_FILE: argsFile,
            },
        });
        assert.equal(result.status, 0, result.stderr);
        const flags = Object.fromEntries(fs.readFileSync(envFile, "utf8").trim()
            .split("\n").map(line => line.split("=")));
        const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim().split("\n") : [];
        return { flags, args };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function parsedSendGridEnv(renderedPath) {
    // Parse the rendered YAML where Ruby is available. The fallback checks all
    // five bindings when the test environment does not include a YAML parser.
    const ruby = spawnSync("ruby", ["-ryaml", "-rjson", "-e",
        'puts JSON.generate(YAML.load_file(ARGV.fetch(0)).fetch("properties").fetch("template").fetch("containers").fetch(0).fetch("env"))',
        renderedPath], { encoding: "utf8" });
    if (!ruby.error) {
        assert.equal(ruby.status, 0, ruby.stderr);
        return JSON.parse(ruby.stdout).filter(entry => names.includes(entry.name));
    }
    assert.equal(ruby.error.code, "ENOENT", ruby.error.message);
    const rendered = fs.readFileSync(renderedPath, "utf8");
    return [...rendered.matchAll(/^          - name: (SENDGRID_[A-Z_]+)\n            (secretRef|value): (.*)$/gm)]
        .map(([, name, field, raw]) => ({ name, [field]: raw === '""' ? "" : raw }));
}

function render(flags) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendgrid-deploy-render-"));
    const yamlPath = path.join(dir, "containerapp.yaml");
    try {
        fs.writeFileSync(yamlPath, template);
        const result = spawnSync("python3", ["-", yamlPath], {
            input: renderer,
            encoding: "utf8",
            env: { ...process.env, ...flags, SENDGRID_API_KEY: "SG.test-secret" },
        });
        assert.equal(result.status, 0, result.stderr);
        const rendered = fs.readFileSync(yamlPath, "utf8");
        assert.ok(!rendered.includes("SENDGRID_ENV_BINDINGS"));
        assert.ok(!rendered.includes("SG.test-secret"), "API key leaked into rendered YAML");
        const entries = parsedSendGridEnv(yamlPath);
        assert.equal(entries.length, names.length);
        return Object.fromEntries(entries.map(({ name, value, secretRef }) => [name,
            secretRef ? { secretRef } : { value }]));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("SendGrid deployment requires a key and valid sender together", () => {
    assert.equal(validate("", "").status, 0);
    assert.equal(validate("SG.test-secret", "booth@example.com").status, 0);
    for (const [key, email] of [
        ["SG.test-secret", ""],
        ["", "booth@example.com"],
        ["SG.test-secret", "invalid-address"],
    ]) {
        const result = validate(key, email);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /::error::/);
    }
});

test("configured SendGrid settings render only Azure secret references", () => {
    const { flags, args } = syncSecrets({
        key: "SG.test-secret", email: "booth@example.com", name: "Photo Booth",
        publicKey: "test-public-key", region: "eu",
    });
    assert.equal(flags.SENDGRID_CONFIGURED, "true");
    assert.ok(args.includes("sendgrid-key=SG.test-secret"));
    assert.ok(args.includes("sendgrid-from-email=booth@example.com"));
    assert.ok(args.includes("sendgrid-event-key=test-public-key"));
    assert.deepEqual(render(flags), {
        SENDGRID_API_KEY: { secretRef: "sendgrid-key" },
        SENDGRID_FROM_EMAIL: { secretRef: "sendgrid-from-email" },
        SENDGRID_FROM_NAME: { secretRef: "sendgrid-from-name" },
        SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: { secretRef: "sendgrid-event-key" },
        SENDGRID_REGION: { secretRef: "sendgrid-region" },
    });
});

test("removing optional SendGrid values clears their app bindings", () => {
    const { flags, args } = syncSecrets({ key: "SG.test-secret", email: "booth@example.com" });
    assert.equal(flags.SENDGRID_CONFIGURED, "true");
    assert.ok(!args.some(arg => arg.startsWith("sendgrid-from-name=")));
    assert.ok(!args.some(arg => arg.startsWith("sendgrid-event-key=")));
    assert.ok(!args.some(arg => arg.startsWith("sendgrid-region=")));
    assert.deepEqual(render(flags), {
        SENDGRID_API_KEY: { secretRef: "sendgrid-key" },
        SENDGRID_FROM_EMAIL: { secretRef: "sendgrid-from-email" },
        SENDGRID_FROM_NAME: { value: "" },
        SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: { value: "" },
        SENDGRID_REGION: { value: "" },
    });
});

test("unconfigured SendGrid disables email even if Azure holds old secrets", () => {
    const { flags, args } = syncSecrets({});
    assert.equal(flags.SENDGRID_CONFIGURED, "false");
    assert.deepEqual(args, []);
    assert.deepEqual(render(flags), Object.fromEntries(names.map(name => [name, { value: "" }])));
});
