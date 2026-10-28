// Synthetic records for the read-only local admin preview.
// No application data, credentials, or network services are loaded here.
const EVENTS = ["DEMO EVENT", "SECOND DEMO EVENT"];
const NAMES = [
  "Alex Rivera", "Morgan Chen", "Sam Patel", "Jordan Lee", "Taylor Kim",
  "Casey Brooks", "Avery Torres", "Riley Morgan", "Jamie Cruz", "Quinn Parker",
];
const STYLES = ["Cartoon", "Pop Art", "Watercolor", "Anime", "Sketch", "Pixel Art"];
const NOW = Date.now();

function padded(number) { return String(number).padStart(3, "0"); }
function prefix(number) { return "demo-" + padded(number); }
function eventFor(number) { return EVENTS[(number - 1) % EVENTS.length]; }
function styleFor(number) { return STYLES[(number - 1) % STYLES.length]; }
function phoneFor(number) { return "••• " + String(1000 + number).slice(-4); }

const recipients = Array.from({ length: 86 }, (_, index) => {
  const number = index + 1;
  return {
    id: number,
    phone: phoneFor(number),
    name: NAMES[index % NAMES.length],
    count: 1 + (index % 3),
    styles: [styleFor(number), styleFor(number + 2)],
    lastActive: NOW - (index + 1) * 8 * 60 * 1000,
    lastPrefix: prefix(number),
    lastEvent: eventFor(number),
    hasThumb: true,
    isWinner: number === 8 || number === 31,
    maxPrints: 3,
    isAdmin: false,
    leadCompleted: number % 4 !== 0,
  };
});

const raffle = [
  { id: 1, maskedPhone: phoneFor(8), event: EVENTS[0], timestamp: NOW - 18 * 60 * 1000 },
  { id: 2, maskedPhone: phoneFor(31), event: EVENTS[1], timestamp: NOW - 4 * 60 * 60 * 1000 },
];

const leads = Array.from({ length: 39 }, (_, index) => {
  const number = index + 1;
  const [firstName, lastName] = NAMES[index % NAMES.length].split(" ");
  return {
    id: number,
    firstName, lastName,
    email: "guest" + number + "@example.test",
    personalEmail: index % 3 === 0 ? "" : "person" + number + "@example.test",
    company: ["Northstar", "Cedar Studio", "Harbor Labs", "Juniper Co."][index % 4],
    jobTitle: ["Designer", "Engineer", "Marketing", "Operations"][index % 4],
    country: ["United States", "Canada", "Brazil"][index % 3],
    phone: phoneFor(number),
    completedAt: NOW - number * 19 * 60 * 1000,
    event: eventFor(number),
  };
});

const kioskSubmissions = Array.from({ length: 32 }, (_, index) => {
  const number = index + 1;
  return {
    id: number,
    filePrefix: prefix(number),
    event: eventFor(number),
    phone: phoneFor(number),
    email: index % 4 === 0 ? "" : "guest" + number + "@example.test",
    style: styleFor(number),
    submittedAt: new Date(NOW - number * 11 * 60 * 1000).toISOString(),
    emailedAt: index % 5 === 0 ? new Date(NOW - number * 9 * 60 * 1000).toISOString() : null,
  };
});

const dropoffs = Array.from({ length: 18 }, (_, index) => {
  const number = index + 1;
  return {
    id: "visit-" + padded(number),
    phone: phoneFor(number + 88),
    firstContactAt: NOW - number * 24 * 60 * 1000,
    nudgedAt: index % 4 === 0 ? NOW - number * 14 * 60 * 1000 : null,
    event: eventFor(number),
  };
});

const galleryImages = Array.from({ length: 108 }, (_, index) => {
  const number = index + 1;
  return {
    file: prefix(number) + "_output.png",
    event: eventFor(number),
    prefix: prefix(number),
    hasAi: true,
    hasSelfie: number % 6 !== 0,
    style: styleFor(number).toLowerCase().replaceAll(" ", "-"),
    orientation: "portrait",
  };
});

const reviewItems = Array.from({ length: 32 }, (_, index) => {
  const number = 201 + index;
  const eventName = index < 30 ? EVENTS[0] : EVENTS[1];
  const shared = { eventName, style: styleFor(number), reviewAt: NOW - (index + 1) * 7 * 60 * 1000 };
  if (index === 0) return {
    ...shared,
    parentJobId: "demo-parent-001",
    variantCount: 3,
    regenerationLimit: 2,
    variants: [301, 302, 303].map((value, variantIndex) => ({
      variantId: "variant-" + (variantIndex + 1),
      filePrefix: prefix(value),
      status: "REVIEW",
      regenCount: variantIndex === 1 ? 1 : 0,
    })),
  };
  return { ...shared, filename: prefix(number) + ".json", filePrefix: prefix(number) };
});

const logs = Array.from({ length: 54 }, (_, index) => {
  const category = ["queue", "pipeline", "print", "sms", "system"][index % 5];
  const level = index % 13 === 0 ? "error" : index % 7 === 0 ? "warn" : "info";
  const messages = {
    queue: "Portrait job moved to the next stage",
    pipeline: "Portrait generation completed",
    print: "Demo printer acknowledged a portrait",
    sms: "Guest delivery update queued",
    system: "Service health check completed",
  };
  return {
    id: index + 1,
    ts: new Date(NOW - (54 - index) * 90 * 1000).toISOString(),
    level,
    category,
    message: messages[category] + " · DEMO EVENT",
  };
});

const evalRuns = Array.from({ length: 68 }, (_, index) => {
  const number = index + 1;
  const status = index === 0 ? "running" : index % 11 === 0 ? "failed" : "completed";
  const total = index === 0 ? 132 : 12 + (index % 4) * 6;
  const done = status === "running" ? Math.floor(total / 2) : status === "failed" ? total - 2 : total;
  return {
    id: "demo-run-" + padded(number),
    name: ["Cartoon detail", "Watercolor lighting", "Sketch linework", "Pop Art color"][index % 4] + " · v" + (1 + Math.floor(index / 4)),
    status,
    createdAt: new Date(NOW - index * 42 * 60 * 1000).toISOString(),
    eventName: index < 58 ? EVENTS[0] : EVENTS[1],
    group: ["Launch prep", "Style tuning", "Delivery tests", ""][index % 4],
    totals: { total, done, failed: status === "failed" ? 2 : 0 },
    totalCostUsd: Number((done * 0.19).toFixed(2)),
    wallMs: status === "running" ? null : 115000 + index * 4200,
    starredCount: index % 7 === 0 ? 2 : 0,
  };
});

const evalStyles = {
  cartoon: { name: "Cartoon", prompt: "Demo cartoon prompt", core: "Keep the face recognizable.", brandCore: "", behavior: "normal" },
  watercolor: { name: "Watercolor", prompt: "Demo watercolor prompt", core: "Soft washes and clear features.", brandCore: "", behavior: "normal" },
  sketch: { name: "Sketch", prompt: "Demo sketch prompt", core: "Expressive lines and natural pose.", brandCore: "", behavior: "normal" },
};

const evalPhotos = [
  { filename: "demo-selfie-01.jpg", displayName: "Demo selfie · Alex", uploadedAt: new Date(NOW - 3 * 86400000).toISOString(), sceneDescription: "A person seated in even daylight against a simple studio background." },
  { filename: "demo-selfie-02.jpg", displayName: "Demo selfie · Morgan", uploadedAt: new Date(NOW - 2 * 86400000).toISOString(), sceneDescription: "A person facing the camera in soft outdoor light." },
];

const evalVariants = [
  {
    name: "Bold cartoon color",
    description: "Brighter color while keeping facial details recognizable.",
    createdAt: new Date(NOW - 5 * 86400000).toISOString(),
    overrides: { styles: { cartoon: { prompt: "Use brighter color and crisp shapes." } }, brands: {} },
  },
  {
    name: "Soft watercolor",
    description: "Gentler edges and warmer lighting.",
    createdAt: new Date(NOW - 4 * 86400000).toISOString(),
    overrides: { styles: { watercolor: { prompt: "Use warm, translucent washes." } }, brands: {} },
  },
];

function evalRunManifest(id) {
  const summary = evalRuns.find((run) => run.id === id);
  if (!summary) return null;
  const photos = evalPhotos.map((photo) => photo.filename);
  const variants = [{ name: "live", type: "live" }, { name: "bold-color", type: "custom" }, { name: "soft-light", type: "custom" }];
  const entries = Array.from({ length: summary.totals.total }, (_, index) => {
    const completed = index % 2 === 0 || summary.status !== "running";
    const failed = summary.status === "failed" && index >= summary.totals.total - 2;
    const status = failed ? "failed" : completed ? "completed" : "pending";
    const startedAt = new Date(NOW - 10 * 60 * 1000 + index * 1000).toISOString();
    return {
      style: ["cartoon", "watercolor"][Math.floor(index / 66) % 2],
      brand: null,
      background: null,
      photo: photos[Math.floor(index / 3) % photos.length],
      variant: variants[index % variants.length].name,
      rep: 1 + Math.floor(index / (photos.length * variants.length)) % 11,
      status,
      outputPath: "demo-" + padded(301 + index) + "_output.png",
      generationMs: completed ? 32000 + (index % 8) * 2500 : null,
      startedAt,
      completedAt: completed ? new Date(NOW - 9 * 60 * 1000 + index * 1000).toISOString() : null,
      error: failed ? "Sample generation error" : null,
    };
  });
  const starred = entries.filter((entry) => entry.status === "completed").slice(0, summary.starredCount).map((entry) => entry.outputPath);
  return {
    ...summary,
    config: { photos, variants },
    entries,
    starred,
    winners: { "cartoon|null|null": { variant: "live", notes: "Clean facial details in the sample set." } },
    notes: "Sample run for the local read-only preview.",
  };
}

const failedJobs = Array.from({ length: 6 }, (_, index) => {
  const number = index + 300;
  return {
    filename: prefix(number) + ".json",
    filePrefix: prefix(number),
    eventName: eventFor(number),
    phone: phoneFor(number),
    name: NAMES[index % NAMES.length],
    style: styleFor(number),
    failReason: ["generation", "printer", "face_detection"][index % 3],
    retries: index % 3,
    createdAt: NOW - (index + 2) * 37 * 60 * 1000,
    hasInputThumb: true,
    canRetry: index % 3 !== 2,
    canReprint: index % 3 === 1,
  };
});

const doneJobs = Array.from({ length: 96 }, (_, index) => {
  const number = index + 1;
  return {
    filename: prefix(number) + ".json",
    filePrefix: prefix(number),
    eventName: eventFor(number),
    phone: phoneFor(number),
    name: NAMES[index % NAMES.length],
    style: styleFor(number),
    printerName: index % 3 === 0 ? "Demo printer" : "",
    completedAt: NOW - (index + 1) * 18 * 60 * 1000,
    hasOutputThumb: true,
    canReprint: true,
  };
});

const activeJobs = [
  {
    filename: "demo-101.json", filePrefix: "demo-101", eventName: EVENTS[0],
    phone: phoneFor(101), name: "Alex Rivera", style: "Cartoon", status: "ready",
    enteredAt: NOW - 9 * 60 * 1000, failedPrinters: [], retries: 0,
  },
  {
    filename: "demo-102.json", filePrefix: "demo-102", eventName: EVENTS[0],
    phone: phoneFor(102), name: "Morgan Chen", style: "Watercolor", status: "printing",
    printerName: "Demo printer", enteredAt: NOW - 4 * 60 * 1000,
  },
];

function limitedRows(items, url, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const filtered = query ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(query)) : items;
  const requested = Number(url.searchParams.get("limit"));
  const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, maxLimit) : defaultLimit;
  const requestedPage = Number(url.searchParams.get("page"));
  const pages = Math.max(1, Math.ceil(filtered.length / limit));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, pages) : 1;
  return { items: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, pages, limit };
}

function dashboardStats(scope) {
  const details = scope === "overview" ? null : {
    nps: { count: 42, average: 4.6, distribution: { 1: 1, 2: 1, 3: 3, 4: 10, 5: 27 } },
    dubAnalytics: { totalClicks: 77, topLinks: [
      { shortLink: "https://demo.example.test/p/101", url: "https://example.test/share/101", clicks: 28 },
      { shortLink: "https://demo.example.test/p/102", url: "https://example.test/share/102", clicks: 18 },
    ] },
    shareClicks: { totalEvents: 55, totalShares: 42, uniqueSharers: 37,
      byPlatform: { x: 11, linkedin: 17, instagram: 8, download: 6 }, recent: [] },
  };
  return {
    eventName: EVENTS[0], events: EVENTS, queuePaused: false, hasReviewPin: false,
    totals: { done: 184, failed: 6 }, prints24h: 27, uniqueUsers: 118, avgPerUser: 1.6,
    queue: { pending: 2, generating: 1, review: 30, ready: 1, printing: 1 },
    printers: [{ name: "Demo printer", status: "ready", message: "Ready" }],
    disabledPrinters: [], enablePrinting: true, immediateDigitalDelivery: true,
    stuckJobs: [], styleCounts: { cartoon: 61, "pop-art": 42, watercolor: 33, anime: 24, sketch: 17, "pixel-art": 7 },
    hourlyActivity: [0,0,0,0,0,1,2,4,6,7,5,8,9,6,8,10,7,5,4,3,2,1,0,0],
    hourlyLabels: ["12a","1a","2a","3a","4a","5a","6a","7a","8a","9a","10a","11a","12p","1p","2p","3p","4p","5p","6p","7p","8p","9p","10p","11p"],
    durations: { avgGenerationSec: 43, avgPrintSec: 18, avgTotalSec: 68 },
    failureBreakdown: { generation: 3, printer: 2, face_detection: 1 },
    countryCounts: [{ country: "United States", count: 82 }, { country: "Canada", count: 22 }, { country: "Brazil", count: 14 }],
    moderationRate: "0.8%",
    ...(details || { nps: null, dubAnalytics: null, shareClicks: null }),
  };
}

function portraitSvg(number, kind = "output") {
  const palette = [
    ["#FCE5DC", "#EF223A", "#252D4A", "#C98761", "#1D2339"],
    ["#DCEBFF", "#2188EF", "#50355F", "#D9A47B", "#2D1D35"],
    ["#E8F5EA", "#1D9D83", "#253B54", "#A96745", "#141C31"],
    ["#F7E9FB", "#A35FC1", "#323E62", "#E5B68E", "#4D2D2A"],
    ["#FFF1D6", "#F3A53B", "#1B4B66", "#B97551", "#18263C"],
    ["#E6F6F6", "#19ABF3", "#603A52", "#D59A73", "#2B263B"],
  ][Math.abs(number) % 6];
  const [background, accent, jacket, skin, hair] = palette;
  const accessory = number % 3 === 0
    ? '<path d="M105 208 Q180 173 255 208" fill="none" stroke="' + hair + '" stroke-width="18" stroke-linecap="round"/>'
    : '';
  const backgroundShape = kind === "input"
    ? '<rect width="360" height="480" fill="#E7E9EC"/><rect y="324" width="360" height="156" fill="#C6CCD4"/>'
    : '<rect width="360" height="480" fill="' + background + '"/><circle cx="295" cy="74" r="125" fill="' + accent + '" opacity=".15"/><circle cx="40" cy="382" r="114" fill="' + accent + '" opacity=".18"/><path d="M0 136 Q88 49 179 129 T360 106" fill="none" stroke="' + accent + '" stroke-width="17" opacity=".36"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480" role="img" aria-label="Synthetic demo portrait">'
    + backgroundShape
    + '<path d="M24 480 Q39 374 113 349 Q180 319 247 349 Q322 374 336 480" fill="' + jacket + '"/>'
    + '<path d="M143 340 L180 385 L217 340" fill="#fff" opacity=".92"/>'
    + '<ellipse cx="180" cy="223" rx="81" ry="106" fill="' + skin + '"/>'
    + '<path d="M99 214 Q90 100 174 99 Q260 90 266 207 Q239 171 209 152 Q151 187 99 214" fill="' + hair + '"/>'
    + accessory
    + '<circle cx="151" cy="228" r="5" fill="' + hair + '"/><circle cx="209" cy="228" r="5" fill="' + hair + '"/>'
    + '<path d="M155 270 Q180 287 205 270" fill="none" stroke="' + hair + '" stroke-width="4" stroke-linecap="round"/>'
    + '<rect x="18" y="18" width="72" height="27" rx="6" fill="#000D25" opacity=".85"/>'
    + '<text x="54" y="37" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="12" font-weight="700">DEMO</text>'
    + '</svg>';
}

module.exports = {
  EVENTS, NOW, recipients, raffle, leads, kioskSubmissions, dropoffs, galleryImages, reviewItems, logs, evalRuns, evalStyles, evalPhotos, evalVariants, evalRunManifest,
  failedJobs, doneJobs, activeJobs, limitedRows, dashboardStats, portraitSvg,
};
