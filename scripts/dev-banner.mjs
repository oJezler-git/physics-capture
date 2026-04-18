const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

function paint(text, r, g, b, bold = false) {
  return `${bold ? BOLD : ""}${rgb(r, g, b)}${text}${RESET}`;
}

function gradient(text, from, to, bold = false) {
  const chars = [...text];
  const out = chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `${bold ? BOLD : ""}${rgb(r, g, b)}${ch}${RESET}`;
  });
  return out.join("");
}

function gradientBorder(ch, t) {
  // Top-left cool blue → bottom-right warm purple
  const r = Math.round(54 + (120 - 54) * t);
  const g = Math.round(73 + (50 - 73) * t);
  const b = Math.round(95 + (180 - 95) * t);
  return paint(ch, r, g, b);
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

function padRight(text, width) {
  const plainLength = stripAnsi(text).length;
  const padding = Math.max(0, width - plainLength);
  return text + " ".repeat(padding);
}

function framed(lines, width = 70) {
  const totalLines = lines.length + 2; // +2 for top/bottom borders
  const top =
    gradientBorder("+", 0) +
    gradientBorder("-".repeat(width + 2), 0) +
    gradientBorder("+", 0);
  const bottom =
    gradientBorder("+", 1) +
    gradientBorder("-".repeat(width + 2), 1) +
    gradientBorder("+", 1);
  const body = lines.map((line, i) => {
    const t = (i + 1) / (totalLines - 1);
    const padded = padRight(line, width);
    return `${gradientBorder("|", t)} ${padded} ${gradientBorder("|", t)}`;
  });
  return [top, ...body, bottom];
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Time-of-day mood ────────────────────────────────────────────────────────
const now = new Date();
const hour = now.getHours();
const isFriday = now.getDay() === 5;
const localTime = now.toLocaleTimeString([], {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function timeOfDayTag() {
  if (hour < 6) return "thermo"; // late night → entropy
  if (hour < 12) return "quantum"; // morning → superposition
  if (hour < 17) return "motivation"; // afternoon → grind
  if (hour < 21) return "waves"; // evening → chill oscillations
  return "thermo"; // night → heat death
}

// ─── Quips ───────────────────────────────────────────────────────────────────
// Each quip: [text, mood_tag]
// mood_tag maps to a cat face
const quipMoods = {
  quantum: { face: "(=?_?=)", color: [180, 140, 255] },
  thermo: { face: "(=^~^=)", color: [255, 160, 80] },
  relativity: { face: "(=^..^=)", color: [100, 200, 255] },
  waves: { face: "(=^-^=)", color: [100, 230, 200] },
  data: { face: "(=^._^=)", color: [200, 220, 255] },
  motivation: { face: "(*^_^*)", color: [96, 211, 148] },
  mechanics: { face: "(=^.^=)", color: [235, 235, 235] },
  rare: { face: "(=^◕ᴥ◕^=)", color: [255, 215, 0] }, // gold
};

const physicsQuips = [
  // [text, tag, rare?]
  // Mechanics
  ["Conserving momentum, not vibes.", "mechanics"],
  ["KE up, noise down.", "mechanics"],
  ["Net force ≠ zero? Good. Something interesting is happening.", "mechanics"],
  ["F = ma, unless it's coursework week, then F = panic.", "mechanics"],
  ["Friction: the universe politely saying 'slow down.'", "mechanics"],
  ["Normal force: quietly doing all the work.", "mechanics"],
  ["Torque it till it works.", "mechanics"],
  ["Equilibrium is just indecision in perfect balance.", "mechanics"],
  ["Energy isn't lost. It's just hiding as heat.", "thermo"],

  // Waves & Oscillations
  ["Phase matters. Timing is everything.", "waves"],
  ["Interference: when waves start drama.", "waves"],
  ["Resonance: small push, big consequences.", "waves"],
  ["Standing waves: going nowhere, efficiently.", "waves"],
  ["Amplitude up, subtlety down.", "waves"],
  ["Frequency high, patience low.", "waves"],

  // Electricity & Fields
  ["Stay grounded.", "mechanics"],
  ["Potential is everywhere; difference makes it matter.", "mechanics"],
  ["Current flows where resistance is lowest—same with effort.", "mechanics"],
  ["Ohm my.", "mechanics", true],
  [
    "Field lines: the universe's way of drawing arrows everywhere.",
    "mechanics",
  ],

  // Thermodynamics
  ["Entropy always wins in the end.", "thermo"],
  ["Heat flows. Deadlines approach.", "thermo"],
  ["No process is perfectly efficient—except procrastination.", "thermo"],
  ["Absolute zero motivation.", "thermo"],
  ["Second law: things get messy.", "thermo"],
  ["Temperature: average chaos, quantified.", "thermo"],

  // Quantum
  ["Observe responsibly.", "quantum"],
  ["Uncertainty is a feature, not a bug.", "quantum"],
  ["Superposition: why choose?", "quantum"],
  ["Wave or particle? Yes.", "quantum"],
  ["Collapse under observation—relatable.", "quantum"],
  ["Tunnelling: when 'no' is just a suggestion.", "quantum"],

  // Relativity
  ["Time is relative. Deadlines feel absolute.", "relativity"],
  ["Light speed: still undefeated.", "relativity"],
  ["Simultaneity is overrated.", "relativity"],
  ["Reference frames change everything.", "relativity"],
  [
    "Mass tells spacetime how to curve; exams tell you how to panic.",
    "relativity",
  ],

  // Data / Modelling
  ["All models are wrong. Some pass validation.", "data"],
  ["Garbage in, garbage out—now in high resolution.", "data"],
  ["Noise is just misunderstood signal.", "data"],
  ["Error bars build character.", "data"],
  ["Plot first, theorise second.", "data"],
  ["Correlation is not causation, no matter how convincing.", "data"],
  ["Delta t is small. Dreams are large.", "data"],
  ["May your residuals be Gaussian.", "data"],

  // Motivation
  ["Trust the maths.", "motivation"],
  ["Derive, don't memorise.", "motivation"],
  ["Units first, numbers second.", "motivation"],
  ["Small steps, continuous progress.", "motivation"],
  ["Reality is the ultimate test case.", "motivation"],
  ["The answer exists. You just haven't derived it yet.", "motivation"],
  ["If it breaks, you learned something.", "motivation"],
  ["Model it. Test it. Refine it.", "motivation"],
  ["You can't fake consistency.", "motivation"],

  // Rare drops (~2% chance via weighted pick)
  ["Maxwell's demon called. It's unionised.", "rare", true],
  ["Schrödinger's deploy: simultaneously broken and fine.", "rare", true],
  ["The gradient descended. No one knows where.", "rare", true],
  ["Planck's constant is the only constant in my life.", "rare", true],
  ["This banner is a closed system. Entropy has entered.", "rare", true],
  ["Feynman diagrams: connect the dots, win the universe.", "rare", true],
];

// Weighted pick: rare quips have ~2% total share
function pickQuip() {
  const normal = physicsQuips.filter((q) => !q[2]);
  const rare = physicsQuips.filter((q) => q[2]);
  if (Math.random() < 0.06 && rare.length) return pick(rare);
  return pick(normal);
}

// Time-of-day bias: 40% chance to pick from preferred tag, else random
function pickQuipBiased() {
  const tag = timeOfDayTag();
  const preferred = physicsQuips.filter((q) => !q[2] && q[1] === tag);
  if (Math.random() < 0.4 && preferred.length) return pick(preferred);
  return pickQuip();
}

const chosenQuip = pickQuipBiased();
const [quipText, quipTag, quipIsRare] = chosenQuip;
const mood = quipMoods[quipTag] || quipMoods.mechanics;

// ─── Layout ──────────────────────────────────────────────────────────────────
const title = gradient(
  "PHYSICS CAPTURE // DEV ORCHESTRATION",
  [0, 203, 255],
  [80, 120, 255],
  true,
);

const subtitleLeft = paint("Live Services", 96, 211, 148, true);
const subtitleMid = `${DIM}${paint("*", 130, 130, 130)}${RESET}`;
const subtitleRight = paint(`Boot @ ${localTime}`, 180, 180, 180);
const subtitle = `${subtitleLeft} ${subtitleMid} ${subtitleRight}`;

const [qr, qg, qb] = mood.color;
const rareBadge = quipIsRare ? ` ${paint("✦ rare", 255, 215, 0, true)}` : "";
const petLine = `${paint(mood.face, qr, qg, qb, true)} ${DIM}${paint("//", 130, 130, 130)}${RESET} ${paint(quipText, 200, 200, 200)}${rareBadge}`;

// ─── Services (with placeholder latency slots) ────────────────────────────────
const serviceList = [
  {
    icon: "*",
    iconColor: [90, 220, 130],
    label: "Frontend",
    labelColor: [132, 255, 183],
    url: "https://localhost:3000",
    urlColor: [205, 255, 228],
  },
  {
    icon: "*",
    iconColor: [90, 160, 255],
    label: "Signaling",
    labelColor: [150, 200, 255],
    url: "ws://localhost:3001",
    urlColor: [214, 233, 255],
  },
  {
    icon: "*",
    iconColor: [255, 211, 107],
    label: "CV gRPC",
    labelColor: [255, 226, 148],
    url: "localhost:50052",
    urlColor: [255, 243, 205],
  },
];

function renderService(svc) {
  return (
    `${paint(svc.icon, ...svc.iconColor)} ` +
    `${paint(svc.label, ...svc.labelColor, true)} ` +
    `${paint(svc.url, ...svc.urlColor)}`
  );
}

// ─── Friday override ──────────────────────────────────────────────────────────
const fridayTag = isFriday
  ? `  ${paint("// it's friday", 255, 215, 0, true)}`
  : "";

const footer = `${DIM}${paint("Press Ctrl+C to stop all services", 170, 170, 170)}${RESET}${fridayTag}`;

// ─── Initial render ───────────────────────────────────────────────────────────
function renderFrame(catFace = mood.face, dot = "·") {
  const animatedPet = `${paint(catFace, qr, qg, qb, true)} ${DIM}${paint(dot, 130, 130, 130)}${RESET} ${paint(quipText, 200, 200, 200)}${rareBadge}`;
  const svcs = serviceList.map((s) => renderService(s));
  return framed([title, subtitle, animatedPet, "", ...svcs, "", footer]);
}

function printFrame(lines) {
  console.log("\x1Bc");
  for (const line of lines) console.log(line);
  console.log("");
}

printFrame(renderFrame());

// ─── Animation: cat wiggles ──────────────────────────────────────────────────
(async () => {
  if (process.env.DEV_BANNER_ANIMATE === "0") return;

  const tailFrames = ["(=^.^=) ~", "(=^ω^=)~~", "(=^･ω･^=)~~~", "(=^.^=)~~"];
  const spinner = ["·", "•", "●", "•"];

  const totalFrames = 12;

  for (let i = 0; i < totalFrames; i++) {
    const face = tailFrames[i % tailFrames.length];
    const dot = spinner[i % spinner.length];

    const animatedPet = `${paint(face, qr, qg, qb, true)} ${DIM}${paint(dot, 130, 130, 130)}${RESET} ${paint(quipText, 200, 200, 200)}${rareBadge}`;
    const svcs = serviceList.map((s) => renderService(s));
    const lines = framed([
      title,
      subtitle,
      animatedPet,
      "",
      ...svcs,
      "",
      footer,
    ]);

    printFrame(lines);
    await sleep(300);
  }
})().catch(() => {});
