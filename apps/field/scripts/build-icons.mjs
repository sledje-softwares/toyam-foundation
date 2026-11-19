// Builds the field app icons from vector sources (the Toyam letterhead logo, redrawn: orange arc,
// graduate in a mortarboard with a green tie, "TOYAM" on a scroll; orange / black swoosh background).
// Run from apps/field: node scripts/build-icons.mjs   (uses sharp from the workspace node_modules)
// Writes assets/icon.png, assets/adaptive-foreground.png, assets/adaptive-background.png,
// assets/adaptive-monochrome.png and assets/brand/*.svg (referenced from app.json).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const OUT = new URL('../assets/', import.meta.url).pathname;
mkdirSync(OUT + 'brand', { recursive: true });

const C = {
  orange: '#E8650F', orangeLight: '#F7892A', orangeDeep: '#C9480A',
  red: '#E8400C', ink: '#141414', cream: '#FFF3D9', creamDark: '#E9C98A', ribbonEdge: '#3B2A14',
  gold: '#F2B233', green: '#3DBB4E', paper: '#FFFDF8',
};
const FONT = "'Liberation Sans', 'Arial', 'DejaVu Sans', sans-serif";

/** Badge: white disc with the orange arc, graduate in a mortarboard, TOYAM scroll. Centred on (512, 512). */
function badge({ mono = false } = {}) {
  const ink = mono ? '#FFFFFF' : C.ink;
  const disc = mono ? '' : `
    <circle cx="512" cy="488" r="282" fill="${C.paper}"/>
    <path d="M 238 452 A 286 286 0 0 1 786 452" fill="none" stroke="${C.orange}" stroke-width="40" stroke-linecap="round"/>`;
  const collar = mono ? '' : `
    <path d="M 478 600 L 512 652 L 546 600 Z" fill="${C.paper}"/>
    <path d="M 503 612 L 521 612 L 527 668 L 512 686 L 497 668 Z" fill="${C.green}"/>`;
  const ribbon = mono
    ? `<text x="512" y="742" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="104" letter-spacing="6" fill="#FFFFFF">TOYAM</text>`
    : `
    <path d="M 214 676 L 290 676 L 290 772 L 214 772 L 244 724 Z" fill="${C.creamDark}" stroke="${C.ribbonEdge}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 810 676 L 734 676 L 734 772 L 810 772 L 780 724 Z" fill="${C.creamDark}" stroke="${C.ribbonEdge}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 262 660 Q 512 628 762 660 L 762 758 Q 512 726 262 758 Z" fill="${C.cream}" stroke="${C.ribbonEdge}" stroke-width="7" stroke-linejoin="round"/>
    <text x="512" y="736" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="100" letter-spacing="5" fill="${C.red}">TOYAM</text>`;
  return `
    ${disc}
    <!-- shoulders -->
    <path d="M 366 690 C 372 628 420 596 480 590 L 544 590 C 604 596 652 628 658 690 Z" fill="${ink}"/>
    ${collar}
    <!-- head -->
    <circle cx="512" cy="522" r="62" fill="${ink}"/>
    <!-- mortarboard: cap band, board, tassel -->
    <path d="M 450 454 L 574 454 L 574 498 Q 512 516 450 498 Z" fill="${ink}"/>
    <path d="M 512 384 L 662 436 L 512 488 L 362 436 Z" fill="${ink}"/>
    <path d="M 512 436 L 628 452 L 628 520" fill="none" stroke="${mono ? '#FFFFFF' : C.gold}" stroke-width="9" stroke-linecap="round"/>
    <path d="M 618 516 L 638 516 L 644 556 L 612 556 Z" fill="${mono ? '#FFFFFF' : C.gold}"/>
    ${ribbon}`;
}

const background = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${C.orangeLight}"/>
      <stop offset="0.55" stop-color="${C.orange}"/>
      <stop offset="1" stop-color="${C.orangeDeep}"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <!-- letterhead swooshes -->
  <path d="M 0 118 C 260 168 640 40 1024 92 L 1024 0 L 0 0 Z" fill="${C.ink}" opacity="0.92"/>
  <path d="M 0 902 C 300 846 690 968 1024 884 L 1024 1024 L 0 1024 Z" fill="${C.ink}"/>
  <path d="M 0 880 C 300 824 690 946 1024 862" fill="none" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="6"/>`;

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`;
// Adaptive icons: the launcher masks to a circle / squircle and only the central 66 % is safe,
// so the badge is scaled to 0.78 around the centre for the foreground layer.
const scaled = (inner, s) => `<g transform="translate(512 512) scale(${s}) translate(-512 -512)">${inner}</g>`;

const files = {
  'brand/icon.svg': svg(background + scaled(badge(), 0.96)),
  'brand/adaptive-foreground.svg': svg(scaled(badge(), 0.74)),
  'brand/adaptive-background.svg': svg(background),
  'brand/adaptive-monochrome.svg': svg(scaled(badge({ mono: true }), 0.74)),
};
for (const [name, text] of Object.entries(files)) writeFileSync(OUT + name, text);

const render = (name, out, size = 1024) =>
  sharp(Buffer.from(files[name]), { density: 144 }).resize(size, size).png({ compressionLevel: 9 }).toFile(OUT + out);
await render('brand/icon.svg', 'icon.png');
await render('brand/adaptive-foreground.svg', 'adaptive-foreground.png');
await render('brand/adaptive-background.svg', 'adaptive-background.png');
await render('brand/adaptive-monochrome.svg', 'adaptive-monochrome.png');
console.log('icons written to', OUT);
