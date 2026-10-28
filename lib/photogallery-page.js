// Lightweight Gallery page renderer. Keep runtime routes and their timers in photogallery.js.
const settings = require("./settings");
const brb = require("./brb");
const i18n = require("./i18n");
const ui = require("./ui-i18n");
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");

function themeToggleButton(opts) {
    const className = (opts && opts.className) || "top-btn";
    const id = (opts && opts.id) || "themeBtn";
    return `<style>
  #${id} .icon-sun, #${id} .icon-moon { display: none; width: 14px; height: 14px; }
  html[data-theme="dark"] #${id} .icon-moon { display: inline-block; }
  html[data-theme="light"] #${id} .icon-sun { display: inline-block; }
</style>
<button type="button" class="${className}" id="${id}" onclick="(function(){var c=document.documentElement.getAttribute('data-theme')||'dark';var n=c==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);localStorage.setItem('twilio-theme',n);if(window.parent!==window)window.parent.postMessage({type:'twilio-theme-change',theme:n},window.location.origin)})()" title="Toggle light/dark mode" aria-label="Toggle light or dark theme">
  <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
  <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
  <span>Theme</span>
</button>`;
}

const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%; height: 100%; overflow: hidden;
  font-family: 'Playfair Display', Georgia, serif;
  -webkit-font-smoothing: antialiased;
}
body {
  background: #000D25;
  background-image:
    radial-gradient(ellipse at 50% 40%, rgba(0,30,80,0.4) 0%, transparent 70%);
}

.scene {
  --count-label-size: clamp(18px,1.6vw,26px);
  --count-number-size: clamp(26px,2.2vw,42px);
  --count-spacing: 4px 16px 8px;
  --thumb-size: clamp(50px,7vh,100px);
  display: flex; flex-direction: column; height: 100vh;
}

/* ── Top bar ── */
.top-bar {
  flex-shrink: 0; display: flex; flex-direction: column; align-items: center;
  padding: clamp(6px,1vh,12px) 20px 0; gap: 0; position: relative; z-index: 5;
}
.top-bar-row {
  display: flex; justify-content: center; align-items: center;
  width: 100%; position: relative; min-height: 36px;
}
.count-label {
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  font-size: var(--count-label-size); color: rgba(242,47,70,0.7);
  font-style: italic; font-weight: 400; letter-spacing: 0.03em;
  text-align: center; flex-shrink: 0; margin-top: auto; padding-bottom: 4px;
}
.count-label strong {
  font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  color: #F22F46; font-weight: 800;
  font-size: var(--count-number-size); font-style: normal;
  display: inline-block;
}
.top-bar.bump strong { animation: cBump .6s cubic-bezier(.36,.07,.19,.97); }
@keyframes cBump {
  0%   { transform: scale(1); color: #F22F46; }
  15%  { transform: scale(1.35); color: var(--th-text, #fff); }
  30%  { transform: scale(0.95); }
  45%  { transform: scale(1.15); color: var(--th-text, #fff); }
  100% { transform: scale(1); color: #F22F46; }
}

.top-controls {
  position: absolute; right: 16px; display: flex; gap: 6px;
}
.left-controls {
  position: absolute; left: 16px; display: flex; align-items: center; gap: 6px;
}
.ev-sel {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 28px 6px 12px; color: rgba(242,47,70,0.8);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23F22F46' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
  transition: all .2s ease; max-width: 220px;
}
.ev-sel:hover { color: #F22F46; background-color: rgba(255,255,255,0.1); }
.ev-sel:focus { outline: none; border-color: rgba(242,47,70,0.3); }
.ev-sel option { background: #1a1a2e; color: #F22F46; }
.top-btn {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 12px; color: rgba(242,47,70,0.6);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 400;
  cursor: pointer; user-select: none; display: flex; align-items: center; gap: 5px;
  transition: all .2s ease;
}
.top-btn:hover { color: #F22F46; background: rgba(255,255,255,0.1); }
.top-btn svg { width: 14px; height: 14px; }

/* ── Book area ── */
.book-area {
  flex: 1; display: flex; align-items: center; justify-content: center;
  min-height: 0; padding: clamp(8px,1.5vh,16px) clamp(30px,4vw,70px); position: relative;
}

/* Book wrapper sizes the book */
.book-wrap {
  width: 82vw; height: 60vh;
  display: flex; align-items: center; justify-content: center;
}
@media (max-width: 900px) { .book-wrap { width: 95vw; height: 55vh; } }
@media (max-height: 600px) { .book-wrap { height: 50vh; } }
:fullscreen .book-wrap, :-webkit-full-screen .book-wrap {
  width: 82vw; height: 64vh;
}

/* Empty state */
.empty-msg {
  font-size: clamp(14px,1.2vw,20px); font-style: italic;
  color: rgba(242,47,70,0.3); line-height: 1.6;
  text-align: center;
}

/* ── Book decoration wrapper ── */
.book-decor {
  position: relative;
  filter: drop-shadow(0 18px 50px rgba(0,0,0,0.45)) drop-shadow(0 3px 10px rgba(0,0,0,0.25));
}

/* Stacked page layers — visible page block (bottom & right edge only, like a real closed book) */
.page-layer {
  position: absolute; pointer-events: none;
  border-radius: 0 1px 1px 0;
}
.page-layer:nth-child(1) {
  right: -2px; bottom: -2px; top: 1px; left: 0;
  background: #ece7de;
  border-right: 1px solid rgba(180,170,155,0.5);
  border-bottom: 1px solid rgba(180,170,155,0.4);
}
.page-layer:nth-child(2) {
  right: -4px; bottom: -3px; top: 2px; left: 0;
  background: #e8e2d8;
  border-right: 1px solid rgba(175,165,148,0.5);
  border-bottom: 1px solid rgba(175,165,148,0.4);
}
.page-layer:nth-child(3) {
  right: -5px; bottom: -5px; top: 3px; left: 0;
  background: #e3ddd2;
  border-right: 1px solid rgba(170,158,140,0.5);
  border-bottom: 1px solid rgba(170,158,140,0.4);
}
.page-layer:nth-child(4) {
  right: -7px; bottom: -6px; top: 4px; left: 0;
  background: #ded7cb;
  border-right: 1px solid rgba(165,153,135,0.5);
  border-bottom: 1px solid rgba(165,153,135,0.4);
}
.page-layer:nth-child(5) {
  right: -8px; bottom: -8px; top: 5px; left: 0;
  background: #d9d1c4;
  border-right: 1px solid rgba(160,148,130,0.5);
  border-bottom: 1px solid rgba(160,148,130,0.45);
}
.page-layer:nth-child(6) {
  right: -10px; bottom: -9px; top: 6px; left: 0;
  background: #d4ccbe;
  border-right: 1px solid rgba(155,142,124,0.5);
  border-bottom: 1px solid rgba(155,142,124,0.45);
  box-shadow: 2px 3px 8px rgba(0,0,0,0.1);
}

/* Hardcover — filled element behind pages with leather-like surface */
.book-cover {
  position: absolute;
  inset: -10px -18px -16px -6px;
  border-radius: 3px 5px 5px 3px;
  pointer-events: none; z-index: -2;
  background:
    linear-gradient(170deg,
      #5a4935 0%, #4e3e2b 20%, #453525 50%,
      #3e2f1f 75%, #352819 100%);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.1),
    inset 0 -2px 0 rgba(0,0,0,0.25),
    inset -2px 0 0 rgba(0,0,0,0.1),
    0 4px 8px rgba(0,0,0,0.3),
    0 1px 3px rgba(0,0,0,0.2);
}
/* Cover grain texture */
.book-cover::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='4' height='4' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E");
  pointer-events: none;
}
/* Spine — rounded ridge at center */
.book-cover::after {
  content: ''; position: absolute;
  left: 50%; top: -1px; bottom: -1px; width: 20px;
  transform: translateX(-50%);
  background:
    linear-gradient(90deg,
      transparent 0%,
      rgba(0,0,0,0.15) 8%,
      rgba(0,0,0,0.28) 22%,
      rgba(0,0,0,0.1) 42%,
      rgba(255,255,255,0.04) 50%,
      rgba(0,0,0,0.1) 58%,
      rgba(0,0,0,0.28) 78%,
      rgba(0,0,0,0.15) 92%,
      transparent 100%);
  border-left: 1px solid rgba(0,0,0,0.15);
  border-right: 1px solid rgba(0,0,0,0.15);
}

/* Page edge strip (right side only — left side is the spine/binding) */
.book-decor::after {
  content: ''; position: absolute; z-index: -1;
  right: -10px; top: 0; bottom: 0; width: 10px;
  border-radius: 0 1px 1px 0;
  background:
    repeating-linear-gradient(180deg,
      #e0d9cd 0px, #e0d9cd 1px,
      #eae4d9 1px, #eae4d9 2px);
  box-shadow: 1px 0 2px rgba(0,0,0,0.08), inset -1px 0 0 rgba(255,255,255,0.12);
}

/* ── Page styling ── */
.page {
  background: linear-gradient(to right, #ece7df 0%, #f5f1e9 8%, #fdfaf5 100%);
  overflow: hidden; position: relative;
  box-shadow:
    inset 0px -1px 2px rgba(50,50,50,0.08),
    inset -1px 0px 1px rgba(150,150,150,0.15);
}
/* Inner gutter shadow — darkens the edge where pages meet the spine */
.page::before {
  content: ''; position: absolute; top: 0; bottom: 0; width: 35px; z-index: 3; pointer-events: none;
}
.page.odd::before {
  left: 0;
  background: linear-gradient(90deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.02) 40%, transparent 100%);
}
.page.even::before, .page:not(.odd)::before {
  right: 0; left: auto;
  background: linear-gradient(270deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.02) 40%, transparent 100%);
}
.page::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.35;
  background-image: url("data:image/svg+xml,%3Csvg width='40' height='40' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
}

/* Photo mount */
.photo-mount {
  position: absolute; z-index: 1;
  top: clamp(18px,3vw,44px);
  left: clamp(18px,3vw,44px);
  right: clamp(18px,3vw,44px);
  bottom: clamp(42px,6vh,68px);
  display: flex; align-items: center; justify-content: center;
}
.photo-frame {
  width: 100%; height: 100%;
  background: #fff;
  padding: clamp(8px,1.2vw,16px);
  box-shadow:
    0 1px 2px rgba(0,0,0,0.06),
    0 3px 8px rgba(0,0,0,0.08),
    0 8px 20px rgba(0,0,0,0.06);
  position: relative;
  display: flex; align-items: center; justify-content: center;
}
.photo-frame img {
  display: block;
  max-width: 100%; max-height: 100%;
  object-fit: contain;
  transition: opacity .4s ease;
}
.photo-frame img.hidden, .photo-frame .original-removed.hidden { opacity: 0; position: absolute; pointer-events: none; }
.photo-frame img.original { position: absolute; inset: clamp(8px,1.2vw,16px); width: auto; height: auto; max-width: calc(100% - clamp(16px,2.4vw,32px)); max-height: calc(100% - clamp(16px,2.4vw,32px)); margin: auto; }
.photo-frame .original-removed {
  position: absolute; inset: clamp(8px,1.2vw,16px); display: flex; align-items: center; justify-content: center;
  background: #000D25; border-radius: 8px; transition: opacity .3s;
}
.removed-content { text-align: center; padding: 1.5rem; }
.removed-content svg { width: 32px; height: 32px; margin-bottom: 0.75rem; opacity: 0.7; }
.removed-content .removed-title {
  font-family: 'Twilio Sans Text', sans-serif; font-weight: 700; font-size: clamp(0.8rem, 1.2vw, 1rem);
  color: #fff; margin-bottom: 0.4rem;
}
.removed-content .removed-desc {
  font-family: 'Twilio Sans Text', sans-serif; font-weight: 400; font-size: clamp(0.65rem, 0.9vw, 0.8rem);
  color: rgba(255,255,255,0.5); line-height: 1.4;
}

/* Photo corner mounts */
.corner {
  position: absolute; width: clamp(14px,1.4vw,22px); height: clamp(14px,1.4vw,22px);
  z-index: 2;
}
.corner::before, .corner::after {
  content: ''; position: absolute;
  background: rgba(160,140,110,0.18);
}
.corner-tl { top: clamp(2px,0.3vw,5px); left: clamp(2px,0.3vw,5px); }
.corner-tl::before { top: 0; left: 0; width: 100%; height: 2px; }
.corner-tl::after { top: 0; left: 0; width: 2px; height: 100%; }
.corner-tr { top: clamp(2px,0.3vw,5px); right: clamp(2px,0.3vw,5px); }
.corner-tr::before { top: 0; right: 0; width: 100%; height: 2px; }
.corner-tr::after { top: 0; right: 0; width: 2px; height: 100%; }
.corner-bl { bottom: clamp(2px,0.3vw,5px); left: clamp(2px,0.3vw,5px); }
.corner-bl::before { bottom: 0; left: 0; width: 100%; height: 2px; }
.corner-bl::after { bottom: 0; left: 0; width: 2px; height: 100%; }
.corner-br { bottom: clamp(2px,0.3vw,5px); right: clamp(2px,0.3vw,5px); }
.corner-br::before { bottom: 0; right: 0; width: 100%; height: 2px; }
.corner-br::after { bottom: 0; right: 0; width: 2px; height: 100%; }

/* Page numbers */
.page-num {
  position: absolute; bottom: clamp(6px,1vh,12px);
  font-size: clamp(12px,1vw,16px); font-style: italic;
  color: rgba(239,34,58,0.7); z-index: 2;
}
.page-num-left { left: clamp(14px,2vw,28px); }
.page-num-right { right: clamp(14px,2vw,28px); }

/* Per-page flip button */
.flip-btn {
  position: absolute; bottom: clamp(12px,2vh,24px); left: 50%;
  transform: translateX(-50%); z-index: 5;
  cursor: pointer; user-select: none;
  background: rgba(239,34,58,0.08);
  border: 1px solid rgba(239,34,58,0.2);
  border-radius: 8px; padding: 4px 14px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: clamp(9px,0.7vw,12px);
  font-weight: 600; color: rgba(239,34,58,0.6);
  transition: all .2s ease; white-space: nowrap;
}
.flip-btn:hover { color: rgba(239,34,58,0.85); background: rgba(239,34,58,0.14); border-color: rgba(239,34,58,0.35); }
.flip-btn.active { color: #EF223A; border-color: rgba(239,34,58,0.4); background: rgba(239,34,58,0.1); }

/* Style tag — positioned opposite the page number to avoid overlap */
.style-tag {
  position: absolute; bottom: clamp(6px,1vh,12px);
  z-index: 5; font-family: 'Twilio Sans Mono', monospace;
  font-size: clamp(10px,0.8vw,13px); font-weight: 400;
  color: rgba(239,34,58,0.7); letter-spacing: 0.03em;
  text-transform: capitalize;
}
.style-tag-left { left: clamp(14px,2vw,28px); }
.style-tag-right { right: clamp(14px,2vw,28px); }

/* ── Nav arrows ── */
.arrow {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 10;
  cursor: pointer; user-select: none;
  width: clamp(42px,3.4vw,54px); height: clamp(42px,3.4vw,54px);
  border-radius: 50%;
  background: rgba(30,22,16,0.6);
  border: 1px solid rgba(210,195,175,0.12);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  color: rgba(210,195,175,0.5);
  transition: all .2s ease;
}
.arrow:hover {
  background: rgba(40,30,22,0.8); color: rgba(240,230,215,0.85);
  border-color: rgba(210,195,175,0.2); transform: translateY(-50%) scale(1.06);
}
.arrow:active { transform: translateY(-50%) scale(0.95); }
.arrow svg { width: 20px; height: 20px; }
.arrow.left { left: clamp(6px,1.2vw,20px); }
.arrow.right { right: clamp(6px,1.2vw,20px); }

/* ── Bottom bar ── */
.bottom-bar {
  flex-shrink: 0; display: none; flex-direction: column; align-items: stretch;
  padding: clamp(6px,1vh,12px) 0 0; width: 100%;
}
.bottom-bar.visible { display: flex; }

.controls {
  display: flex; gap: 8px; margin-bottom: clamp(6px,0.8vh,10px);
  justify-content: center; position: relative; z-index: 20;
}
.ctrl-btn {
  background: rgba(255,255,255,0.05); border: 1px solid rgba(210,195,175,0.1);
  border-radius: 10px; padding: 7px 16px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; font-weight: 400;
  color: rgba(242,47,70,0.5); cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px;
  transition: all .2s ease;
}
.ctrl-btn:hover { color: #F22F46; background: rgba(255,255,255,0.08); }
.ctrl-btn:active { transform: scale(0.97); }
.ctrl-btn.active { color: #F22F46; border-color: rgba(242,47,70,0.25); }
.ctrl-btn svg { width: 15px; height: 15px; flex-shrink: 0; }

/* ── Thumbnail strip ── */
.thumbs-bar {
  flex-shrink: 0; padding: clamp(4px,0.6vh,8px) 0 clamp(10px,1.4vh,18px);
  width: 100%;
}
.thumbs {
  display: flex; gap: clamp(8px,0.7vw,12px);
  overflow-x: auto; padding: 0 clamp(16px,3vw,40px);
  scrollbar-width: none; scroll-behavior: smooth;
}
.thumbs::-webkit-scrollbar { display: none; }
.thumb {
  width: var(--thumb-size); height: var(--thumb-size);
  flex-shrink: 0; cursor: pointer;
  background: #fff; padding: 3px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.15);
  opacity: 0.4;
  transition: all .25s ease;
}
.thumb:hover { opacity: 0.75; transform: translateY(-3px) rotate(-1deg); }
.thumb.active {
  opacity: 1; transform: translateY(-2px);
  box-shadow: 0 2px 6px rgba(0,0,0,0.25), 0 0 0 2px rgba(242,47,70,0.5);
}
.thumb.landscape { width: clamp(75px,10.5vh,150px); }
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }

/* Portrait signage: make the count a clear headline and the filmstrip usable
   from several feet away. The portrait-host class is set when this page sits inside a
   portrait combo whose individual iframe is not itself portrait-shaped. */
@media (orientation: portrait) {
  html:not(.combo-embedded) .scene {
    --count-label-size: clamp(42px,5.5vw,68px);
    --count-number-size: clamp(80px,9vw,124px);
    --count-spacing: clamp(110px,10vh,170px) 18px clamp(42px,5vh,76px);
    --thumb-size: clamp(82px,11vw,132px);
  }
  html:not(.combo-embedded) .top-bar { padding-top: clamp(14px,2vh,28px); }
  html:not(.combo-embedded) .count-label { margin: 0; padding: var(--count-spacing); line-height: 1.15; }
  html:not(.combo-embedded) .book-wrap { width: 86vw; height: 58vh; }
  html:not(.combo-embedded) .thumbs { gap: clamp(12px,1.6vw,20px); padding-inline: clamp(22px,4vw,52px); }
  html:not(.combo-embedded) .thumbs-bar { padding-bottom: clamp(16px,2vh,28px); }
}
html.portrait-host .scene {
  --count-label-size: clamp(30px,3.8vw,48px);
  --count-number-size: clamp(52px,6vw,78px);
  --count-spacing: clamp(32px,4vh,54px) 16px clamp(24px,3vh,42px);
  --thumb-size: clamp(76px,10vw,120px);
}
html.portrait-host .top-bar { padding-top: clamp(10px,1.5vh,22px); }
html.portrait-host .count-label { margin: 0; padding: var(--count-spacing); line-height: 1.15; }
html.portrait-host .book-wrap { width: 86vw; height: 56vh; }
html.portrait-host .thumbs { gap: clamp(12px,1.4vw,18px); padding-inline: clamp(20px,3vw,44px); }

/* ── Fullscreen overrides ── */
:fullscreen .top-bar, :-webkit-full-screen .top-bar, .fs-active .top-bar {
  opacity: 0; transition: opacity 0.3s ease;
}
:fullscreen .top-bar:hover, :-webkit-full-screen .top-bar:hover, .fs-active .top-bar:hover {
  opacity: 1;
}
:fullscreen .thumb, :-webkit-full-screen .thumb {
  width: clamp(60px,8vh,120px); height: clamp(60px,8vh,120px); padding: 4px;
}
:fullscreen .thumbs, :-webkit-full-screen .thumbs {
  gap: clamp(10px,1vw,18px);
}
:fullscreen .count-label, :-webkit-full-screen .count-label, .fs-active .count-label {
  font-size: clamp(24px,2.2vw,36px);
}
:fullscreen .count-label strong, :-webkit-full-screen .count-label strong, .fs-active .count-label strong {
  font-size: clamp(36px,3.2vw,56px);
}
:fullscreen .page-num, :-webkit-full-screen .page-num {
  font-size: clamp(14px,1.2vw,20px);
}
:fullscreen .flip-btn, :-webkit-full-screen .flip-btn {
  font-size: clamp(11px,0.8vw,14px); padding: 5px 18px;
}
/* Fullscreen must not downsize portrait signage. */
@media (orientation: portrait) {
  html:not(.combo-embedded):fullscreen .count-label,
  html:not(.combo-embedded):-webkit-full-screen .count-label,
  html:not(.combo-embedded) .fs-active .count-label { font-size: var(--count-label-size); }
  html:not(.combo-embedded):fullscreen .count-label strong,
  html:not(.combo-embedded):-webkit-full-screen .count-label strong,
  html:not(.combo-embedded) .fs-active .count-label strong { font-size: var(--count-number-size); }
}
html.portrait-host .fs-active .count-label { font-size: var(--count-label-size); }
html.portrait-host .fs-active .count-label strong { font-size: var(--count-number-size); }
.terms-notice {
  flex-shrink: 0; padding: 6px 16px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(242,47,70,0.2); text-align: center;
}

/* ── Manage mode ── */
.top-btn.manage-active {
  background: rgba(242,47,70,0.15); color: #F22F46;
  border-color: rgba(242,47,70,0.4);
}
.manage-grid {
  display: none; flex: 1; overflow-y: auto; padding: 16px clamp(16px,3vw,40px);
  min-height: 0;
}
.manage-grid.visible { display: block; }
.manage-grid-inner {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}
.mg-card {
  position: relative; cursor: pointer; border-radius: 8px; overflow: hidden;
  background: #1a1a2e; border: 2px solid transparent;
  transition: border-color .2s, transform .15s;
}
.mg-card:hover { transform: translateY(-2px); }
.mg-card.selected { border-color: #F22F46; }
.mg-card .mg-check {
  position: absolute; top: 8px; left: 8px; width: 22px; height: 22px;
  border-radius: 50%; border: 2px solid rgba(255,255,255,0.4);
  background: rgba(0,0,0,0.4); z-index: 2;
  display: flex; align-items: center; justify-content: center;
  transition: all .2s;
}
.mg-card.selected .mg-check {
  background: #F22F46; border-color: #F22F46;
}
.mg-card .mg-check svg { width: 14px; height: 14px; opacity: 0; transition: opacity .2s; }
.mg-card.selected .mg-check svg { opacity: 1; }
.mg-card img { width: 100%; aspect-ratio: 1; object-fit: contain; display: block; background: #fff; }
.mg-card .mg-label {
  padding: 6px 8px; font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 10px;
  color: rgba(242,47,70,0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mg-type-row {
  display: flex; gap: 4px; padding: 0 8px 6px;
}
.mg-type-tag {
  font-family: 'Twilio Sans Mono', monospace; font-size: 9px; font-weight: 700;
  padding: 2px 6px; border-radius: 4px; text-transform: uppercase;
}
.mg-type-tag.ai { background: rgba(33,136,239,0.15); color: #2188EF; }
.mg-type-tag.selfie { background: rgba(239,34,58,0.15); color: #F83D53; }

/* Action bar */
.action-bar {
  display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
  background: rgba(15,18,25,0.95); backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255,255,255,0.08);
  padding: 12px 20px; align-items: center; gap: 12px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
.action-bar.visible { display: flex; }
.action-bar .ab-count {
  font-size: 13px; color: rgba(210,195,175,0.7); margin-right: auto;
}
.action-bar .ab-count strong { color: #2188EF; }
.ab-btn {
  padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 12px; font-weight: 700;
  cursor: pointer; transition: all .2s; background: rgba(255,255,255,0.06);
  color: rgba(210,195,175,0.7);
}
.ab-btn:hover { background: rgba(255,255,255,0.1); color: rgba(240,230,215,0.9); }
.ab-btn.danger { background: rgba(220,50,50,0.15); border-color: rgba(220,50,50,0.3); color: #e85555; }
.ab-btn.danger:hover { background: rgba(220,50,50,0.25); color: #ff6b6b; }
.ab-delete-wrap { position: relative; }
.ab-delete-menu {
  display: none; position: absolute; bottom: calc(100% + 8px); right: 0;
  background: #1a1e2e; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px; min-width: 200px; overflow: hidden; z-index: 110;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.ab-delete-menu.open { display: block; }
.ab-delete-menu button {
  display: block; width: 100%; padding: 12px 16px; border: none; background: none;
  color: rgba(210,195,175,0.8); font-family: inherit; font-size: 13px; font-weight: 600;
  text-align: left; cursor: pointer; transition: background .15s;
}
.ab-delete-menu button:hover { background: rgba(255,255,255,0.06); }
.ab-delete-menu button + button { border-top: 1px solid rgba(255,255,255,0.06); }
.ab-delete-menu .ab-dm-destructive { color: #e85555; }
.ab-delete-menu .ab-dm-destructive:hover { background: rgba(220,50,50,0.12); }
.ab-move-sel {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 6px 28px 6px 12px; color: rgba(33,136,239,0.8);
  font-family: 'Twilio Sans Text', sans-serif; font-size: 12px;
  cursor: pointer; appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(33,136,239,0.5)'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center;
}
.ab-move-sel:hover { border-color: rgba(33,136,239,0.3); }
.cb-confirm.move { background: rgba(33,136,239,0.8); }
.cb-confirm.move:hover { background: rgba(33,136,239,1); }

/* Confirmation modal */
.confirm-overlay {
  display: none; position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
  align-items: center; justify-content: center;
}
.confirm-overlay.visible { display: flex; }
.confirm-box {
  background: #1a1e2e; border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px; padding: 24px; max-width: 400px; width: 90%;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; text-align: center;
}
.confirm-box h3 { color: #e8e0d4; font-size: 16px; margin-bottom: 8px; }
.confirm-box p { color: rgba(210,195,175,0.6); font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
.confirm-btns { display: flex; gap: 10px; justify-content: center; }
.confirm-btns button {
  padding: 10px 24px; border-radius: 8px; border: none;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; font-weight: 700;
  cursor: pointer; transition: all .2s;
}
.confirm-btns .cb-cancel { background: rgba(255,255,255,0.08); color: rgba(210,195,175,0.7); }
.confirm-btns .cb-cancel:hover { background: rgba(255,255,255,0.12); }
.confirm-btns .cb-confirm { background: #dc3232; color: #fff; }
.confirm-btns .cb-confirm:hover { background: #e84545; }

/* Toast */
.toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: rgba(30,35,50,0.95); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; padding: 10px 20px; z-index: 300;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 13px; color: #2188EF;
  opacity: 0; transition: opacity .3s; pointer-events: none;
}
.toast.show { opacity: 1; }

/* Manage grid empty state */
.mg-empty {
  grid-column: 1 / -1; text-align: center; padding: 60px 20px;
  font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 14px; color: rgba(210,195,175,0.3);
  font-style: italic;
}

/* Photo enlarge modal */
.photo-modal {
  display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background: rgba(0,0,0,.88); z-index: 9999;
  align-items: center; justify-content: center;
}
.photo-modal.open { display: flex; }
.photo-modal-content { position: relative; max-width: 92vw; max-height: 92vh; }
.photo-modal-content img {
  max-width: 90vw; max-height: 88vh; border-radius: 8px;
  box-shadow: 0 12px 60px rgba(0,0,0,.6);
}
.photo-modal-close {
  position: absolute; top: -14px; right: -14px;
  background: rgba(30,22,16,0.8); color: rgba(240,230,215,0.8);
  border: 1px solid rgba(210,195,175,0.2);
  width: 34px; height: 34px; border-radius: 50%; font-size: 20px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  line-height: 1; backdrop-filter: blur(8px); transition: all .2s;
}
.photo-modal-close:hover { background: #EF223A; border-color: #EF223A; color: #fff; }
/* Spacebar flip — rotateY briefly hides the face while we swap src */
#photoModalImg {
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.6, 1);
  transform-style: preserve-3d;
  backface-visibility: hidden;
}
#photoModalImg.flipping { transform: rotateY(90deg); }
.photo-modal-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  background: rgba(30,22,16,0.8); color: rgba(240,230,215,0.9);
  border: 1px solid rgba(210,195,175,0.2);
  width: 48px; height: 48px; border-radius: 50%; font-size: 24px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  line-height: 1; backdrop-filter: blur(8px); transition: all .2s;
  user-select: none;
}
.photo-modal-nav:hover { background: #EF223A; border-color: #EF223A; color: #fff; }
.photo-modal-nav-prev { left: -64px; }
.photo-modal-nav-next { right: -64px; }
@media (max-width: 900px) {
  /* On narrow viewports, the ±64px offset pushes buttons off-screen.
     Overlay them inside the image edges instead. */
  .photo-modal-nav-prev { left: 8px; }
  .photo-modal-nav-next { right: 8px; }
}
.photo-frame img.portrait, .photo-frame img.original { cursor: pointer; }

/* ── Reveal animations ── */
@keyframes reveal-pixel {
  0%   { filter: blur(20px) brightness(0.5); }
  100% { filter: blur(0) brightness(1); }
}
@keyframes reveal-brush {
  0%   { clip-path: inset(0 100% 0 0); }
  100% { clip-path: inset(0 0 0 0); }
}
@keyframes reveal-sketch-to-color {
  0%   { filter: grayscale(1) contrast(2); }
  100% { filter: grayscale(0) contrast(1); }
}
.portrait.reveal-pixel { animation: reveal-pixel 1.5s ease-out forwards; }
.portrait.reveal-brush { animation: reveal-brush 1.5s ease-in-out forwards; }
.portrait.reveal-sketch-to-color { animation: reveal-sketch-to-color 2s ease-out forwards; }

/* ── Milestone banner ── */
@keyframes milestone-in { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.7); } 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes milestone-out { 0% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); } }
.milestone-banner {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 9000; pointer-events: none;
  background: rgba(0,13,37,0.9); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(239,34,58,0.35); border-radius: 20px;
  padding: 32px 56px; text-align: center;
  font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: clamp(28px, 4vw, 56px); font-weight: 800;
  letter-spacing: 0.02em;
  color: #EF223A; text-shadow: 0 0 30px rgba(239,34,58,0.3);
  box-shadow: 0 8px 60px rgba(0,0,0,0.6), 0 0 40px rgba(239,34,58,0.12);
  display: none; opacity: 0;
}
.milestone-banner.show { display: block; animation: milestone-in 0.5s ease-out forwards; }
.milestone-banner.hide { animation: milestone-out 0.5s ease-in forwards; }

/* ── Light theme overrides ─────────────────────────────────────────────────
   Flips the page background + chrome surfaces to match the light CSS vars
   from /assets/twilio-brand.css. The Twilio red accent stays; we only swap
   the "deep space" dark blue background for white and adjust text/border
   contrasts. The book pages themselves (cream paper) look good on both. */
html[data-theme="light"] body {
  background: var(--th-bg, #FFFFFF);
  background-image:
    radial-gradient(ellipse at 50% 55%, rgba(239,34,58,0.18) 0%, rgba(239,34,58,0.08) 30%, transparent 64%),
    linear-gradient(155deg, #FFFFFF 0%, #FFF7F8 48%, #F3F6FF 100%);
  background-attachment: fixed;
}
html[data-theme="light"] .ev-sel,
html[data-theme="light"] .top-btn {
  background: var(--th-bg-subtle, #F3F4F7);
  border-color: var(--th-card-border, #DDE0E6);
  color: var(--brand-red, #EF223A);
}
html[data-theme="light"] .ev-sel:hover,
html[data-theme="light"] .top-btn:hover {
  background: var(--th-card-hover, #E8EAEF);
  color: var(--brand-red-hover, #DB132A);
}
html[data-theme="light"] .ev-sel option { background: #FFFFFF; color: var(--brand-red, #EF223A); }
html[data-theme="light"] .count-label { color: rgba(239,34,58,0.85); }
html[data-theme="light"] .count-label strong { color: var(--brand-red, #EF223A); }
html[data-theme="light"] .milestone-banner {
  background: var(--th-card, #FFFFFF);
  border-color: rgba(239,34,58,0.3);
  color: var(--brand-red, #EF223A);
  box-shadow: 0 8px 60px rgba(0,0,0,0.15), 0 0 40px rgba(239,34,58,0.08);
}
html[data-theme="light"] .empty-msg { color: rgba(239,34,58,0.5); }
html[data-theme="light"] .arrow {
  background: rgba(255,255,255,0.9); border-color: var(--th-card-border, #DDE0E6);
  color: var(--th-text-muted, #656E87); box-shadow: 0 2px 8px rgba(0,13,37,0.08);
}
html[data-theme="light"] .arrow:hover { background: #FFFFFF; color: var(--th-text, #000D25); }
html[data-theme="light"] .ctrl-btn,
html[data-theme="light"] .ab-btn {
  background: var(--th-card, #FFFFFF); border-color: var(--th-card-border, #DDE0E6); color: var(--th-text-dim, #4D5777);
}
html[data-theme="light"] .ab-move-sel {
  background-color: var(--th-card, #FFFFFF); border-color: var(--th-card-border, #DDE0E6); color: #1866EE;
}
html[data-theme="light"] .ctrl-btn:hover,
html[data-theme="light"] .ab-btn:hover { background: var(--th-card-hover, #E8EAEF); color: var(--th-text, #000D25); }
html[data-theme="light"] .ctrl-btn.active,
html[data-theme="light"] .top-btn.manage-active { color: var(--brand-red, #EF223A); border-color: rgba(239,34,58,0.4); background: rgba(239,34,58,0.1); }
html[data-theme="light"] .terms-notice { color: var(--th-text-muted, #656E87); }
html[data-theme="light"] .mg-card,
html[data-theme="light"] .confirm-box,
html[data-theme="light"] .ab-delete-menu {
  background: var(--th-card, #FFFFFF); border-color: var(--th-card-border, #DDE0E6);
}
html[data-theme="light"] .mg-card.selected { border-color: var(--brand-red, #EF223A); }
html[data-theme="light"] .mg-card .mg-label,
html[data-theme="light"] .action-bar .ab-count,
html[data-theme="light"] .confirm-box p,
html[data-theme="light"] .mg-empty { color: var(--th-text-dim, #4D5777); }
html[data-theme="light"] .action-bar { background: rgba(255,255,255,0.94); border-top-color: var(--th-card-border, #DDE0E6); }
html[data-theme="light"] .ab-delete-menu { box-shadow: 0 8px 32px rgba(0,13,37,0.12); }
html[data-theme="light"] .ab-delete-menu button { color: var(--th-text-secondary, #38425E); }
html[data-theme="light"] .ab-delete-menu button:hover { background: var(--th-card-hover, #E8EAEF); }
html[data-theme="light"] .ab-btn.danger,
html[data-theme="light"] .ab-delete-menu .ab-dm-destructive { color: #B10F23; border-color: rgba(220,50,50,0.3); background-color: rgba(220,50,50,0.08); }
html[data-theme="light"] .ab-btn.danger:hover,
html[data-theme="light"] .ab-delete-menu .ab-dm-destructive:hover { color: #B10F23; background: rgba(220,50,50,0.15); }
html[data-theme="light"] .confirm-overlay,
html[data-theme="light"] .photo-modal { background: rgba(0,13,37,0.45); }
html[data-theme="light"] .confirm-box h3 { color: var(--th-text, #000D25); }
html[data-theme="light"] .confirm-btns .cb-cancel,
html[data-theme="light"] .photo-modal-close,
html[data-theme="light"] .photo-modal-nav {
  background: rgba(255,255,255,0.92); color: var(--th-text, #000D25); border-color: var(--th-card-border, #DDE0E6);
}
html[data-theme="light"] .photo-modal-close:hover,
html[data-theme="light"] .photo-modal-nav:hover { background: #EF223A; border-color: #EF223A; color: #FFFFFF; }
html[data-theme="light"] .toast {
  background: rgba(255,255,255,0.96); border-color: var(--th-card-border, #DDE0E6); color: #1866EE;
  box-shadow: 0 4px 16px rgba(0,13,37,0.12);
}
`;

const PAGE_BODY = `
<div class="scene">
  {{SITE_NAV}}
  <div class="top-bar" id="topBar">
    <div class="top-bar-row">
      {{GALLERY_BRAND}}
      <div class="left-controls">
        <label class="event-label" for="evSel">Event</label>
        <select class="ev-sel" id="evSel" onchange="onEventChange()"></select>
        <button type="button" class="top-btn share-btn" onclick="copyShareLink()" title="Copy shareable link for this event"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0-7.07 7.07l1.71-1.71"/></svg><span>Copy Link</span></button>
      </div>
      <div class="top-controls">
        <button type="button" class="top-btn" id="manageBtn" onclick="toggleManage()" aria-label="Manage portraits" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>Manage</span></button>
        <details class="display-menu" id="displayMenu">
          <summary class="top-btn display-trigger" aria-label="Display controls"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8m-4-3v3"/></svg><span>Display</span><span class="display-chevron" aria-hidden="true"></span></summary>
          <div class="display-menu-panel">
            <button type="button" class="top-btn" id="brbBtn" aria-label="Be right back display"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg><span>Be right back</span></button>
            ${themeToggleButton({ className: "top-btn", id: "gallThemeBtn" })}
            <button type="button" class="top-btn" onclick="toggleFullscreen()" aria-label="Toggle fullscreen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></button>
          </div>
        </details>
      </div>
    </div>
  </div>

  <span class="count-label"><strong id="countNum">0</strong> portraits created</span>
  <div class="book-area">
    <button type="button" class="arrow left" onclick="goPrev()" aria-label="Previous page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <div class="book-wrap" id="bookWrap">
      <div class="empty-msg" id="emptyMsg">Portraits will appear<br>as they are created&hellip;</div>
    </div>
    <button type="button" class="arrow right" onclick="goNext()" aria-label="Next page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
  </div>

  <div class="bottom-bar" id="bottomBar">
    <div class="controls">
      <span class="filmstrip-title">Portrait previews</span>
      <button type="button" class="ctrl-btn active" id="playPauseBtn" aria-label="Pause slideshow"><svg id="ppIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg><span id="ppLabel">Playing</span></button>
    </div>
    <div class="thumbs-bar">
      <button type="button" class="thumb-scroll" id="thumbScrollPrev" onclick="scrollThumbs(-1)" aria-label="Scroll previews left" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div class="thumbs" id="thumbs" role="group" aria-label="Portrait previews"></div>
      <button type="button" class="thumb-scroll" id="thumbScrollNext" onclick="scrollThumbs(1)" aria-label="Scroll previews right" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg></button>
    </div>
  </div>
  <div class="manage-grid" id="manageGrid">
    <div class="manage-header"><h2>Manage portraits</h2><p>Select photos to move or delete. Browse older photos in batches below.</p></div>
    <div class="manage-grid-inner" id="manageGridInner"></div>
  </div>
  <nav class="page-nav" id="pageNav" aria-label="Gallery pages">
    <span class="page-range" id="pageRange" aria-live="polite"></span>
    <div class="page-nav-actions">
      <button type="button" id="newestBatchBtn" onclick="goNewestBatch()">Latest photos</button>
      <button type="button" id="newerBatchBtn" onclick="goNewerBatch()" disabled>Newer photos</button>
      <button type="button" id="olderBatchBtn" onclick="goOlderBatch()" disabled>Older photos</button>
    </div>
  </nav>
  <div class="terms-notice" id="termsNotice" style="display:none"></div>
</div>
<div class="action-bar" id="actionBar">
  <span class="ab-count"><strong id="abCount">0</strong> selected</span>
  <button class="ab-btn" onclick="manageSelectAll()">Select page</button>
  <button class="ab-btn" onclick="manageDeselectAll()">Clear selection</button>
  <select class="ab-move-sel" id="abMoveSel" style="display:none"><option value="">Move to...</option></select>
  <button class="ab-btn" id="abMoveBtn" onclick="manageMoveSelected()" style="display:none">Move</button>
  <div class="ab-delete-wrap" id="abDeleteWrap">
    <button class="ab-btn danger" onclick="toggleDeleteMenu(event)">Delete &#9662;</button>
    <div class="ab-delete-menu" id="abDeleteMenu">
      <button onclick="manageDeleteSelected()">Delete Selected</button>
      <button onclick="manageDeleteSelfies()">Delete Selfies Only</button>
      <button class="ab-dm-destructive" onclick="manageDeleteAll()">Delete All for Event</button>
    </div>
  </div>
</div>
<div class="confirm-overlay" id="confirmOverlay">
  <div class="confirm-box">
    <h3 id="confirmTitle">Confirm Delete</h3>
    <p id="confirmMsg">Are you sure?</p>
    <div class="confirm-btns">
      <button class="cb-cancel" onclick="closeConfirm()">Cancel</button>
      <button class="cb-confirm" id="confirmBtn" onclick="confirmAction()">Delete</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<div class="milestone-banner" id="milestoneBanner"></div>
<div class="photo-modal" id="photoModal" role="dialog" aria-modal="true" aria-label="Portrait viewer" onclick="closePhotoModal(event)">
  <div class="photo-modal-content">
    <img id="photoModalImg" src="" alt="Portrait">
    <button type="button" class="photo-modal-nav photo-modal-nav-prev" onclick="cyclePhotoModal(-1); event.stopPropagation();" title="Previous photo" aria-label="Previous photo">&lsaquo;</button>
    <button type="button" class="photo-modal-nav photo-modal-nav-next" onclick="cyclePhotoModal(1); event.stopPropagation();" title="Next photo" aria-label="Next photo">&rsaquo;</button>
    <button type="button" class="photo-modal-close" onclick="closePhotoModal()" aria-label="Close portrait">&times;</button>
  </div>
</div>
`;

const PAGE_JS = `
var images = [];
var IMAGE_PAGE_SIZE = document.querySelector(".scene.admin-gallery") ? 24 : 48;
var galleryTotal = 0, pageOffset = 0;
var pageCursor = "", nextCursor = null, pageHistory = [];
var newPortraitsAvailable = false;
var allEvents = [];
var bookReady = false;
var bookUsesTurn = false, fallbackPage = 1;
var autoTimer = null, paused = false;
var AUTO_INTERVAL = 10000, POLL_INTERVAL = 5000, photoBookAutoplay = true;
// When a new photo lands, pin it on page 1 for this long before autoplay
// resumes — covers the time for someone to walk from the kiosk to the
// photo book display and actually see their portrait.
var NEW_PHOTO_HOLD_MS = 20000;
// Set while holding page 1 for a new photo — prevents the turn.js "turned"
// callback from restarting autoplay prematurely when we pin to page 1.
var _holdingNewPhoto = false;
var _holdingTimer = null;
var flipped = {};
var selectedEvent = "";
var revealAnimation = "off";
var revealedImages = new Set();
var lastMilestone = parseInt(sessionStorage.getItem("lastMilestone") || "0");
var milestonesEnabled = true;
var milestoneInterval = 100;

function hostIsPortrait() {
  try { return window.top !== window && window.top.innerHeight > window.top.innerWidth; }
  catch(e) { return false; }
}
function syncPortraitHost() {
  document.documentElement.classList.toggle("combo-embedded", window.top !== window);
  document.documentElement.classList.toggle("portrait-host", hostIsPortrait());
}
function getBookSize(w, h) {
  var ratio = getBookRatio();
  var bookW = Math.min(w, h * ratio);
  var bookH = bookW / ratio;
  if (bookH > h) { bookH = h; bookW = bookH * ratio; }
  return { width: bookW, height: bookH };
}
syncPortraitHost();

function imgUrl(img) { return "/photogallery/img/" + encodeURIComponent(img.event) + "/" + encodeURIComponent(img.file); }
function origUrl(img) { return "/photogallery/img/" + encodeURIComponent(img.event) + "/" + encodeURIComponent(img.file.replace("_output.png", "_input.jpg")); }
function thumbUrl(img, kind) {
  var file = kind === "selfie" ? img.file.replace("_output.png", "_input.jpg") : img.file;
  return "/photogallery/thumb/" + encodeURIComponent(img.event) + "/" + encodeURIComponent(file);
}
function htmlEscape(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
function hydrateImage(img) {
  if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
}
function hydrateBookPages(page) {
  // turn.js keeps every page in the DOM. Fetch the visible spread and nearby
  // portraits; original selfies load only if the visitor asks to flip one.
  for (var i = Math.max(0, page - 3); i < Math.min(images.length, page + 3); i++) {
    var node = document.querySelector('.page[data-index="' + i + '"]');
    if (!node) continue;
    hydrateImage(node.querySelector(".portrait"));
  }
}
function getBookRatio() {
  return images.length > 0 && images.every(function(img) { return img.orientation === "landscape"; }) ? 3 : 1.5;
}
function bookPage() { return bookUsesTurn ? $("#book").turn("page") : fallbackPage; }
function bookPages() { return bookUsesTurn ? $("#book").turn("pages") : images.length; }
function bookView() {
  return bookUsesTurn ? $("#book").turn("view") : [fallbackPage, Math.min(fallbackPage + 1, images.length)];
}
function setBookPage(page) {
  if (!bookReady) return;
  if (bookUsesTurn) { $("#book").turn("page", page); return; }
  fallbackPage = Math.min(Math.max(1, Math.floor((page - 1) / 2) * 2 + 1), Math.max(1, images.length));
  document.querySelectorAll("#book .page").forEach(function(node, index) {
    node.classList.toggle("fallback-visible", index + 1 === fallbackPage || index + 1 === fallbackPage + 1);
  });
  hydrateBookPages(fallbackPage);
  highlightThumbs();
}
function bookNext() {
  if (bookUsesTurn) $("#book").turn("next");
  else setBookPage(fallbackPage + 2);
}
function bookPrevious() {
  if (bookUsesTurn) $("#book").turn("previous");
  else setBookPage(fallbackPage - 2);
}

/* ── Build the book ── */
function initBook() {
  var wrap = document.getElementById("bookWrap");
  wrap.style.setProperty("--book-ratio", String(getBookRatio()));

  // Destroy previous book if any
  var oldDecor = document.getElementById("bookDecor");
  if (oldDecor) {
    var oldBook = document.getElementById("book");
    if (oldBook && bookUsesTurn) { try { $(oldBook).turn("destroy"); } catch(e) {} }
    oldDecor.remove();
  }
  bookReady = false;
  bookUsesTurn = false;
  flipped = {};

  if (images.length === 0) {
    document.getElementById("emptyMsg").style.display = "";
    document.getElementById("bottomBar").classList.remove("visible");
    document.getElementById("thumbs").innerHTML = "";
    return;
  }

  document.getElementById("emptyMsg").style.display = "none";
  document.getElementById("bottomBar").classList.add("visible");

  // Create decoration wrapper
  var decor = document.createElement("div");
  decor.className = "book-decor";
  decor.id = "bookDecor";

  // Page layers (stacked behind)
  for (var l = 0; l < 6; l++) {
    var layer = document.createElement("div");
    layer.className = "page-layer";
    decor.appendChild(layer);
  }

  // Book cover border
  var cover = document.createElement("div");
  cover.className = "book-cover";
  decor.appendChild(cover);

  // Create book element
  var book = document.createElement("div");
  book.id = "book";
  book.style.position = "relative";
  book.style.zIndex = "2";
  var n = images.length;

  for (var i = 0; i < n; i++) {
    var pg = document.createElement("div");
    pg.dataset.index = i;
    // turn.js: odd pages (1,3,5…) = right, even pages (2,4,6…) = left
    var turnPage = i + 1;
    var isRight = (turnPage % 2 === 1);
    pg.className = "page " + (isRight ? "odd" : "even");
    var pageNum = galleryTotal - pageOffset - i;

    // Label the portrait itself. A paginated batch may contain only one style
    // even when older batches contain others, so batch style counts cannot
    // decide whether this portrait gets a label.
    var styleTag = images[i].style ? '<div class="style-tag ' + (isRight ? 'style-tag-left' : 'style-tag-right') + '">' + htmlEscape(images[i].style) + '</div>' : '';
    pg.innerHTML =
      '<div class="photo-mount">' +
        '<div class="photo-frame">' +
          '<div class="corner corner-tl"></div>' +
          '<div class="corner corner-tr"></div>' +
          '<div class="corner corner-bl"></div>' +
          '<div class="corner corner-br"></div>' +
          '<img class="portrait" data-index="' + i + '" data-src="' + imgUrl(images[i]) + '" loading="lazy" decoding="async" alt="Portrait ' + pageNum + '">' +
          (images[i].hasSelfie !== false
            ? '<img class="original hidden" data-index="' + i + '" data-src="' + origUrl(images[i]) + '" loading="lazy" decoding="async" alt="Original selfie ' + pageNum + '">'
            : '<div class="original hidden original-removed"><div class="removed-content"><svg viewBox="0 0 24 24" fill="none" stroke="#EF223A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/><circle cx="12" cy="16" r="1"/></svg><div class="removed-title">Original Photo Removed</div><div class="removed-desc">The original selfie has been deleted to protect the subject&#39;s privacy.</div></div></div>') +
        '</div>' +
      '</div>' +
      '<button type="button" class="flip-btn" data-idx="' + i + '">View Original</button>' +
      styleTag +
      '<div class="page-num ' + (isRight ? 'page-num-right' : 'page-num-left') + '">' + pageNum + '</div>';
    book.appendChild(pg);
  }

  decor.appendChild(book);
  wrap.appendChild(decor);
  hydrateBookPages(1);

  // Size the book to fill the wrapper
  var w = wrap.clientWidth;
  var h = wrap.clientHeight;
  var size = getBookSize(w, h);
  var bookW = size.width;
  var bookH = size.height;

  decor.style.width = bookW + "px";
  decor.style.height = bookH + "px";

  bookUsesTurn = typeof window.jQuery === "function" && !!window.jQuery.fn.turn;
  if (bookUsesTurn) {
    $(book).turn({
      width: bookW,
      height: bookH,
      display: "double",
      acceleration: true,
      gradients: true,
      elevation: 50,
      page: 1,
      when: {
        turning: function(e, page) { hydrateBookPages(page); },
        turned: function(e, page) {
          hydrateBookPages(page);
          highlightThumbs();
          // During a new-photo hold, skip the autoplay restart so we
          // actually stay on page 1 for the full hold window.
          if (!paused && !_holdingNewPhoto) startAuto();
        }
      }
    });
  } else {
    book.classList.add("book-fallback");
    book.style.width = bookW + "px";
    book.style.height = bookH + "px";
  }

  bookReady = true;

  book.addEventListener("click", function(e) {
    var btn = e.target.closest(".flip-btn");
    if (btn) toggleFlip(Number(btn.dataset.idx), btn);
  });

  if (!bookUsesTurn) setBookPage(1);
  highlightThumbs();
}

var _fetchingImages = null, _fetchingLatest = false;

/* ── Fetch events ── */
async function fetchEvents() {
  try {
    var eventParam = new URLSearchParams(window.location.search).get("event") || "";
    var langParam = new URLSearchParams(window.location.search).get("lang") || "";
    var r = await fetch("api/events?event=" + encodeURIComponent(eventParam) + "&lang=" + encodeURIComponent(langParam)), d = await r.json();
    allEvents = d.events || [];
    revealAnimation = d.revealAnimation || "off";
    milestonesEnabled = d.milestonesEnabled !== false;
    milestoneInterval = d.milestoneInterval || 100;
    var newAutoplay = d.photoBookAutoplay !== false;
    var newInterval = (d.photoBookInterval || 10) * 1000;
    if (newInterval !== AUTO_INTERVAL || newAutoplay !== photoBookAutoplay) {
      AUTO_INTERVAL = newInterval;
      photoBookAutoplay = newAutoplay;
      if (!paused && photoBookAutoplay) { startAuto(); }
      else if (!photoBookAutoplay) { stopAuto(); paused = true; updatePPBtn(); }
    }
    var sel = document.getElementById("evSel");
    var prev = sel.value || d.currentEvent;
    sel.replaceChildren(new Option("All Events", "all"));
    for (var i = 0; i < d.events.length; i++) sel.add(new Option(d.events[i], d.events[i]));
    sel.value = prev;
    var urlEvent = new URLSearchParams(window.location.search).get("event");
    if (urlEvent === "all" || (urlEvent && d.events.indexOf(urlEvent) >= 0)) {
      selectedEvent = urlEvent;
      sel.value = urlEvent;
    } else if (!selectedEvent) {
      selectedEvent = d.currentEvent;
      sel.value = d.currentEvent;
    }
    var tn = document.getElementById("termsNotice");
    if (d.termsUrl) { tn.textContent = "By participating, you agree to our terms of service: " + d.termsUrl; tn.style.display = ""; }
    else { tn.style.display = "none"; }
  } catch(e) {}
}

function onEventChange() {
  selectedEvent = document.getElementById("evSel").value;
  var url = new URL(window.location);
  if (selectedEvent) url.searchParams.set("event", selectedEvent);
  else url.searchParams.delete("event");
  location.href = url.toString();
}

function copyShareLink() {
  var url = new URL(window.location);
  if (selectedEvent) url.searchParams.set("event", selectedEvent);
  else url.searchParams.delete("event");
  navigator.clipboard.writeText(url.toString()).then(function() { showToast("Link copied!"); }, function() { showToast("Unable to copy link"); });
}

/* ── Fetch images ── */
function imageRenderSignature(items) {
  return items.map(function(img) {
    return [img.event, img.file, img.orientation, img.style || "", img.hasSelfie !== false].join(":");
  }).join("|");
}

function galleryQuery(cursor, limit) {
  var searchParams = new URLSearchParams();
  if (selectedEvent) searchParams.set("event", selectedEvent);
  searchParams.set("limit", String(limit));
  if (cursor) searchParams.set("cursor", cursor);
  return "api/images?" + searchParams.toString();
}

function applyGalleryTotal(total) {
  var oldTotal = galleryTotal;
  galleryTotal = total;
  updateCount(total, oldTotal);
  if (pageCursor && total > oldTotal && oldTotal > 0) newPortraitsAvailable = true;

  if (milestonesEnabled && total > oldTotal && oldTotal > 0 && milestoneInterval > 0) {
    var nextThreshold = Math.ceil((oldTotal + 1) / milestoneInterval) * milestoneInterval;
    if (total >= nextThreshold && nextThreshold > lastMilestone) {
      var highest = Math.floor(total / milestoneInterval) * milestoneInterval;
      if (highest > lastMilestone) {
        lastMilestone = highest;
        sessionStorage.setItem("lastMilestone", String(lastMilestone));
        triggerMilestone(highest);
      }
    }
  }
  return oldTotal;
}

function updatePageNav() {
  var nav = document.getElementById("pageNav");
  nav.classList.toggle("visible", manageMode || galleryTotal > IMAGE_PAGE_SIZE || !!pageCursor);
  var end = Math.min(pageOffset + images.length, galleryTotal);
  document.getElementById("pageRange").textContent = galleryTotal
    ? "Showing " + (pageOffset + 1).toLocaleString() + "–" + end.toLocaleString() + " of " + galleryTotal.toLocaleString() + " portraits"
    : "Ready for the first portrait";
  nav.querySelector(".page-nav-actions").hidden = galleryTotal <= IMAGE_PAGE_SIZE && !pageCursor;
  var latest = document.getElementById("newestBatchBtn");
  latest.hidden = !pageCursor && !newPortraitsAvailable;
  latest.textContent = newPortraitsAvailable ? "New portraits available" : "Latest photos";
  latest.classList.toggle("has-new", newPortraitsAvailable);
  document.getElementById("newerBatchBtn").disabled = pageHistory.length === 0;
  document.getElementById("olderBatchBtn").disabled = !nextCursor;
}

function fetchImages() {
  if (_fetchingImages) return _fetchingImages;
  _fetchingImages = _loadImages().finally(function() { _fetchingImages = null; });
  return _fetchingImages;
}

async function _loadImages() {
  try {
    var r = await fetch(galleryQuery(pageCursor, IMAGE_PAGE_SIZE));
    if (!r.ok) throw new Error("Gallery request failed");
    var d = await r.json();
    if (!Array.isArray(d.images)) throw new Error("Invalid Gallery response");
    var oldLen = images.length;
    var oldSignature = imageRenderSignature(images);
    var nextImages = d.images;
    var renderChanged = imageRenderSignature(nextImages) !== oldSignature || d.offset !== pageOffset;
    images = nextImages;
    pageOffset = d.offset || 0;
    nextCursor = d.cursor || null;
    var oldTotal = applyGalleryTotal(d.total);
    if (!pageCursor) newPortraitsAvailable = false;
    updatePageNav();

    if (renderChanged) {
      var isNewPhoto = !pageCursor && d.total > oldTotal && oldTotal > 0;
      if (manageMode) {
        renderManageGrid();
        updateAbCount();
      } else {
        renderThumbs();
        // The filmstrip changes the available height. Populate it before
        // measuring bookWrap so the cover cannot overlap the portrait count.
        initBook();
      }
      if (!manageMode && oldLen === 0 && d.total > 0 && photoBookAutoplay && !paused && !document.hidden) {
        startAuto();
      } else if (!manageMode && isNewPhoto && !paused && !document.hidden) {
        // Someone just generated a new portrait — stop autoplay, pin the
        // book to page 1 (newest), then resume autoplay after a longer
        // beat so anyone walking up from the kiosk/SMS actually sees
        // their photo before the slideshow moves on.
        // If a previous hold is still running (a photo arrived <20s ago),
        // clear its timer so we don't end up with two timeouts racing to
        // unset _holdingNewPhoto.
        stopAuto();
        if (_holdingTimer) { clearTimeout(_holdingTimer); _holdingTimer = null; }
        _holdingNewPhoto = true;
        try { setBookPage(1); } catch(e) {}
        highlightThumbs();
        _holdingTimer = setTimeout(function() {
          _holdingNewPhoto = false;
          _holdingTimer = null;
          if (!paused && photoBookAutoplay && !document.hidden) startAuto();
        }, NEW_PHOTO_HOLD_MS);
      }
    }
    return true;
  } catch(e) {
    if (!images.length) document.getElementById("emptyMsg").textContent = "Gallery unavailable. Retrying…";
    return false;
  }
}

async function pollLatestTotal() {
  if (_fetchingLatest || document.hidden) return;
  _fetchingLatest = true;
  var requestedCursor = pageCursor;
  try {
    var r = await fetch(galleryQuery(requestedCursor, 1));
    if (!r.ok) return;
    var d = await r.json();
    if (pageCursor !== requestedCursor) return;
    if (typeof d.total === "number") {
      pageOffset = d.offset || 0;
      applyGalleryTotal(d.total);
      document.querySelectorAll(".page-num").forEach(function(number, i) {
        number.textContent = galleryTotal - pageOffset - i;
      });
      updatePageNav();
    }
  } catch(e) {} finally { _fetchingLatest = false; }
}

async function goOlderBatch() {
  if (!nextCursor) return;
  if (_fetchingImages) await _fetchingImages;
  if (!nextCursor) return;
  var previousCursor = pageCursor;
  pageHistory.push(previousCursor);
  pageCursor = nextCursor;
  if (!await fetchImages()) {
    pageCursor = previousCursor;
    pageHistory.pop();
    showToast("Could not load older photos");
  }
}
async function goNewerBatch() {
  if (_fetchingImages) await _fetchingImages;
  if (!pageHistory.length) return;
  var previousCursor = pageCursor;
  pageCursor = pageHistory.pop();
  if (!await fetchImages()) {
    pageHistory.push(pageCursor);
    pageCursor = previousCursor;
    showToast("Could not load newer photos");
  }
}
async function goNewestBatch() {
  if (_fetchingImages) await _fetchingImages;
  var previousCursor = pageCursor, previousHistory = pageHistory;
  pageHistory = [];
  pageCursor = "";
  if (!await fetchImages()) {
    pageCursor = previousCursor;
    pageHistory = previousHistory;
    showToast("Could not load the latest photos");
  }
}

function updateCount(t, o) {
  document.getElementById("countNum").textContent = t;
  if (t > o && o > 0) {
    var b = document.querySelector(".count-label");
    b.classList.remove("bump");
    void b.offsetWidth;
    b.classList.add("bump");
  }
}

/* ── Navigation ── */
function goNext() {
  if (!bookReady) return;
  bookNext();
}
function goPrev() {
  if (!bookReady) return;
  bookPrevious();
}

/* ── Thumbnails ── */
var thumbObserver = null;
function renderThumbs() {
  var c = document.getElementById("thumbs");
  if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
  var h = "";
  for (var i = 0; i < images.length; i++) {
    h += '<button type="button" class="thumb ' + (images[i].orientation === "landscape" ? "landscape" : "portrait") + '" data-page="' + (i + 1) + '" aria-label="View portrait ' + (galleryTotal - pageOffset - i) + '"><img data-src="' + thumbUrl(images[i], "ai") + '" loading="lazy" decoding="async" alt=""></button>';
  }
  c.innerHTML = h;
  c.querySelectorAll(".thumb").forEach(function(t) {
    t.addEventListener("click", function() {
      if (!bookReady) return;
      var pg = parseInt(this.dataset.page);
      setBookPage(pg);
    });
  });
  var thumbnailImages = c.querySelectorAll("img[data-src]");
  if ("IntersectionObserver" in window) {
    thumbObserver = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) { hydrateImage(entry.target); thumbObserver.unobserve(entry.target); }
      });
    }, { root: c, rootMargin: "220px" });
    thumbnailImages.forEach(function(img) { thumbObserver.observe(img); });
  } else thumbnailImages.forEach(hydrateImage);
  requestAnimationFrame(updateThumbScrollButtons);
}

function scrollThumbs(direction) {
  var strip = document.getElementById("thumbs");
  strip.scrollBy({ left: direction * Math.max(160, strip.clientWidth * 0.7), behavior: "smooth" });
}

function updateThumbScrollButtons() {
  var strip = document.getElementById("thumbs");
  document.getElementById("thumbScrollPrev").disabled = strip.scrollLeft <= 1;
  document.getElementById("thumbScrollNext").disabled = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1;
}

function highlightThumbs() {
  if (!bookReady) return;
  var view = bookView();
  var thumbs = document.querySelectorAll(".thumb");
  thumbs.forEach(function(t) {
    var pg = parseInt(t.dataset.page);
    t.classList.toggle("active", view.indexOf(pg) !== -1);
  });
  // Scroll active into view
  var tc = document.getElementById("thumbs");
  var first = view[0] || view[1];
  if (first && thumbs[first - 1]) {
    var thumb = thumbs[first - 1];
    var scrollLeft = thumb.offsetLeft - tc.clientWidth / 2 + thumb.offsetWidth / 2;
    tc.scrollTo({ left: scrollLeft, behavior: "smooth" });
  }
}

/* ── Auto-rotate ── */
function updatePPBtn() {
  var ic = document.getElementById("ppIcon"), lb = document.getElementById("ppLabel"), bt = document.getElementById("playPauseBtn");
  if (paused) {
    ic.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    lb.textContent = "Paused"; bt.classList.remove("active");
    bt.setAttribute("aria-label", "Resume slideshow");
  } else {
    ic.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
    lb.textContent = "Playing"; bt.classList.add("active");
    bt.setAttribute("aria-label", "Pause slideshow");
  }
}
function startAuto() {
  stopAuto(); paused = false; updatePPBtn();
  if (document.hidden) return;
  autoTimer = setInterval(function() {
    if (!bookReady) return;
    var cur = bookPage();
    var total = bookPages();
    if (cur + 2 > total) {
      setBookPage(1);
    } else {
      bookNext();
    }
  }, AUTO_INTERVAL);
}
function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }
function togglePause() { if (paused) startAuto(); else { stopAuto(); paused = true; updatePPBtn(); } }

/* ── View Original (swap images) ── */
function toggleFlip(idx, btn) {
  var page = document.querySelector('.page[data-index="' + idx + '"]');
  if (!page) return;
  var portrait = page.querySelector(".portrait");
  var original = page.querySelector(".original");
  flipped[idx] = !flipped[idx];
  if (flipped[idx]) {
    hydrateImage(original);
    portrait.classList.add("hidden");
    original.classList.remove("hidden");
    btn.textContent = "View Portrait"; btn.classList.add("active");
  } else {
    original.classList.add("hidden");
    portrait.classList.remove("hidden");
    btn.textContent = "View Original"; btn.classList.remove("active");
    // Play reveal animation when flipping back to portrait
    if (revealAnimation !== "off") {
      portrait.classList.remove("reveal-pixel", "reveal-brush", "reveal-sketch-to-color");
      void portrait.offsetWidth; // force reflow to restart animation
      portrait.classList.add("reveal-" + revealAnimation);
    }
  }
}

/* ── Fullscreen ── */
function toggleFullscreen() {
  // Use top-level document when embedded in an iframe (e.g. combo page)
  var doc = window.top.document;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    if (doc.exitFullscreen) doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
  } else {
    var el = doc.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
}

/* Resize book on fullscreen change */
function resizeBook() {
  if (!bookReady) return;
  setTimeout(function() {
    var wrap = document.getElementById("bookWrap");
    var decor = document.getElementById("bookDecor");
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    syncPortraitHost();
    var size = getBookSize(w, h);
    var bookW = size.width;
    var bookH = size.height;
    if (decor) { decor.style.width = bookW + "px"; decor.style.height = bookH + "px"; }
    if (bookUsesTurn) $("#book").turn("size", bookW, bookH);
    else {
      var book = document.getElementById("book");
      if (book) { book.style.width = bookW + "px"; book.style.height = bookH + "px"; }
    }
  }, 100);
}
var wakeLockSentinel = null;
async function handleWakeLock() {
  var doc = (window.top !== window) ? window.top.document : document;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    try { wakeLockSentinel = await navigator.wakeLock.request("screen"); } catch(e) {}
  } else {
    if (wakeLockSentinel) { try { await wakeLockSentinel.release(); } catch(e) {} wakeLockSentinel = null; }
  }
}
function syncFullscreenClass() {
  var doc = (window.top !== window) ? window.top.document : document;
  var isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  document.querySelector(".scene").classList.toggle("fs-active", isFs);
}
function onFullscreenChange() { resizeBook(); handleWakeLock(); syncFullscreenClass(); }
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);
// Also listen on top document for combo/iframe fullscreen
try {
  if (window.top !== window) {
    window.top.document.addEventListener("fullscreenchange", onFullscreenChange);
    window.top.document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }
} catch(e) {}
window.addEventListener("resize", function() { syncPortraitHost(); resizeBook(); });

/* ── Keyboard ── */
document.addEventListener("keydown", function(e) {
  // Don't turn the book (or toggle autoplay) while the photo modal is open —
  // the modal sits on top of the book and the user expects their keys to act
  // on it, not the page behind it. Escape continues to be handled by the
  // modal's own listener.
  var modal = document.getElementById("photoModal");
  if (modal && modal.classList.contains("open")) return;
  // Let the event picker, display menu, and other controls keep their native
  // keyboard behavior. Space opens the menu instead of pausing the book.
  if (e.target && e.target.closest && e.target.closest("button, select, input, textarea, summary, a, [contenteditable]")) return;
  if (e.key === "ArrowRight") { goNext(); e.preventDefault(); }
  else if (e.key === "ArrowLeft") { goPrev(); e.preventDefault(); }
  else if (e.key === " ") { togglePause(); e.preventDefault(); }
});

/* ── Manage mode ── */
var manageMode = false;
// Include event in the selection key so matching filenames across events do
// not get mixed up while browsing All Events or across pages.
var selected = new Set();
var pendingConfirmAction = null;

function selKey(event, prefix, type) { return JSON.stringify([event, prefix, type]); }

function toggleManage() {
  manageMode = !manageMode;
  var btn = document.getElementById("manageBtn");
  btn.classList.toggle("manage-active", manageMode);
  btn.setAttribute("aria-pressed", String(manageMode));
  btn.setAttribute("aria-label", manageMode ? "Close portrait management" : "Manage portraits");
  btn.querySelector("span").textContent = manageMode ? "Close Manage" : "Manage";

  // Toggle views
  var bookArea = document.querySelector(".book-area");
  bookArea.style.display = manageMode ? "none" : "";
  document.getElementById("bottomBar").style.display = manageMode ? "none" : "";
  document.getElementById("manageGrid").classList.toggle("visible", manageMode);
  document.getElementById("actionBar").classList.toggle("visible", manageMode);
  document.querySelector(".scene").classList.toggle("manage-mode", manageMode);
  updatePageNav();

  if (manageMode) {
    stopAuto();
    selected.clear();
    renderManageGrid();
    updateAbCount();
  } else {
    renderThumbs();
    initBook();
    if (!paused && images.length > 0) startAuto();
  }
}

function renderManageGrid() {
  var container = document.getElementById("manageGridInner");
  if (images.length === 0) {
    container.innerHTML = '<div class="mg-empty">No images to manage</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < images.length; i++) {
    var img = images[i];
    var prefix = img.prefix || img.file.replace(/_output\.png$/, "");
    var safeEvent = htmlEscape(img.event), safePrefix = htmlEscape(prefix);
    // AI output card
    html += '<button type="button" class="mg-card" data-prefix="' + safePrefix + '" data-event="' + safeEvent + '" data-type="ai" aria-pressed="false" onclick="toggleSelect(this)">' +
      '<div class="mg-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
      '<img src="' + thumbUrl(img, "ai") + '" loading="lazy" decoding="async" alt="">' +
      '<div class="mg-label">' + safeEvent + '</div>' +
      '<div class="mg-type-row"><span class="mg-type-tag ai">AI Output</span></div>' +
      '</button>';
    // Selfie card (only if selfie exists)
    if (img.hasSelfie !== false) {
      html += '<button type="button" class="mg-card" data-prefix="' + safePrefix + '" data-event="' + safeEvent + '" data-type="selfie" aria-pressed="false" onclick="toggleSelect(this)">' +
        '<div class="mg-check"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
        '<img src="' + thumbUrl(img, "selfie") + '" loading="lazy" decoding="async" alt="">' +
        '<div class="mg-label">' + safeEvent + '</div>' +
        '<div class="mg-type-row"><span class="mg-type-tag selfie">Selfie</span></div>' +
        '</button>';
    }
  }
  container.innerHTML = html;
  container.querySelectorAll(".mg-card").forEach(function(card) {
    var isSelected = selected.has(selKey(card.dataset.event, card.dataset.prefix, card.dataset.type));
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  });
}

function toggleSelect(card) {
  var key = selKey(card.dataset.event, card.dataset.prefix, card.dataset.type);
  if (selected.has(key)) {
    selected.delete(key);
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
  } else {
    selected.add(key);
    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");
  }
  updateAbCount();
}

function updateAbCount() {
  document.getElementById("abCount").textContent = selected.size;
  var showMove = selected.size > 0 && selectedEvent && selectedEvent !== "all";
  document.getElementById("abMoveSel").style.display = showMove ? "" : "none";
  document.getElementById("abMoveBtn").style.display = showMove ? "" : "none";
  if (showMove) updateMoveDropdown();
}

function updateMoveDropdown() {
  var sel = document.getElementById("abMoveSel");
  var prev = sel.value;
  sel.replaceChildren(new Option("Move to...", ""));
  for (var i = 0; i < allEvents.length; i++) {
    if (allEvents[i] !== selectedEvent) sel.add(new Option(allEvents[i], allEvents[i]));
  }
  sel.value = prev;
}

function manageSelectAll() {
  document.querySelectorAll(".mg-card").forEach(function(card) {
    selected.add(selKey(card.dataset.event, card.dataset.prefix, card.dataset.type));
    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");
  });
  updateAbCount();
}

function manageDeselectAll() {
  selected.clear();
  document.querySelectorAll(".mg-card").forEach(function(card) {
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
  });
  updateAbCount();
}

function toggleDeleteMenu(e) {
  if (e) e.stopPropagation();
  var menu = document.getElementById("abDeleteMenu");
  var isOpen = menu.classList.contains("open");
  menu.classList.toggle("open");
  if (!isOpen) {
    // Close on outside click
    setTimeout(function() {
      document.addEventListener("click", closeDeleteMenu);
    }, 0);
  }
}
function closeDeleteMenu() {
  document.getElementById("abDeleteMenu").classList.remove("open");
  document.removeEventListener("click", closeDeleteMenu);
}

function manageDeleteSelfies() {
  closeDeleteMenu();
  var ev = selectedEvent || "current event";
  if (ev === "all") {
    showToast("Select a specific event first");
    return;
  }
  showConfirm(
    "Delete Selfies for " + ev,
    "Permanently delete all original selfie photos for event '" + ev + "'? AI-generated outputs will be kept. This cannot be undone.",
    "deleteSelfies"
  );
}

function manageDeleteSelected() {
  closeDeleteMenu();
  if (selected.size === 0) { showToast("Select photos first"); return; }
  // Count types for the message
  var aiCount = 0, selfieCount = 0;
  selected.forEach(function(key) {
    if (JSON.parse(key)[2] === "ai") aiCount++;
    else selfieCount++;
  });
  var parts = [];
  if (aiCount) parts.push(aiCount + " AI output(s)");
  if (selfieCount) parts.push(selfieCount + " selfie(s)");
  showConfirm(
    "Delete Selected",
    "Permanently delete " + parts.join(" and ") + "? This cannot be undone.",
    "deleteSelected"
  );
}

function manageDeleteAll() {
  closeDeleteMenu();
  var ev = selectedEvent || "current event";
  if (ev === "all") {
    showToast("Select a specific event first");
    return;
  }
  showConfirm(
    "Delete All for " + ev,
    "Permanently delete ALL images (AI outputs and selfies) for event '" + ev + "'? This cannot be undone.",
    "deleteAll"
  );
}

function manageMoveSelected() {
  if (selected.size === 0) return;
  var toEvent = document.getElementById("abMoveSel").value;
  if (!toEvent) { showToast("Select a target event first"); return; }
  if (selectedEvent === "all") { showToast("Select a specific source event first"); return; }
  // Deduplicate prefixes (AI + selfie cards share a prefix)
  var prefixSet = Object.create(null);
  selected.forEach(function(key) {
    var parts = JSON.parse(key);
    if (parts[0] === selectedEvent) prefixSet[parts[1]] = true;
  });
  var count = Object.keys(prefixSet).length;
  showConfirm(
    "Move Photos",
    "Move " + count + " photo(s) from '" + selectedEvent + "' to '" + toEvent + "'?",
    "moveSelected",
    "Move",
    "move"
  );
}

function showConfirm(title, msg, action, btnLabel, btnClass) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMsg").textContent = msg;
  var btn = document.getElementById("confirmBtn");
  btn.textContent = btnLabel || "Delete";
  btn.className = "cb-confirm" + (btnClass ? " " + btnClass : "");
  pendingConfirmAction = action;
  document.getElementById("confirmOverlay").classList.add("visible");
}

function closeConfirm() {
  document.getElementById("confirmOverlay").classList.remove("visible");
  pendingConfirmAction = null;
}

async function confirmAction() {
  var action = pendingConfirmAction;
  closeConfirm();
  if (!action) return;

  if (action === "deleteSelected") {
    // Group by event, then build items with prefix+type
    var byEvent = Object.create(null);
    selected.forEach(function(key) {
      var parts = JSON.parse(key);
      var ev = parts[0], prefix = parts[1], type = parts[2];
      if (!byEvent[ev]) byEvent[ev] = [];
      byEvent[ev].push({ prefix: prefix, type: type });
    });
    var totalDeleted = 0;
    for (var ev in byEvent) {
      try {
        var r = await fetch("/photogallery/api/images", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: ev, items: byEvent[ev] })
        });
        var d = await r.json();
        totalDeleted += d.deleted;
      } catch(e) {}
    }
    selected.clear();
    showToast("Deleted " + totalDeleted + " files");
    await refreshManage();

  } else if (action === "deleteSelfies") {
    var ev = selectedEvent;
    try {
      var r = await fetch("/photogallery/api/images/all", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: ev, type: "selfie" })
      });
      var d = await r.json();
      showToast("Deleted " + d.deleted + " selfies from " + ev);
    } catch(e) {
      showToast("Delete failed");
    }
    selected.clear();
    await refreshManage();

  } else if (action === "deleteAll") {
    var ev = selectedEvent;
    try {
      var r = await fetch("/photogallery/api/images/all", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: ev })
      });
      var d = await r.json();
      showToast("Deleted " + d.deleted + " files from " + ev);
    } catch(e) {
      showToast("Delete failed");
    }
    selected.clear();
    await refreshManage();

  } else if (action === "moveSelected") {
    var toEvent = document.getElementById("abMoveSel").value;
    if (!toEvent) return;
    // Deduplicate prefixes
    var prefixSet = Object.create(null);
    selected.forEach(function(key) {
      var parts = JSON.parse(key);
      if (parts[0] === selectedEvent) prefixSet[parts[1]] = true;
    });
    var prefixes = Object.keys(prefixSet);
    try {
      var r = await fetch("/photogallery/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: prefixes, fromEvent: selectedEvent, toEvent: toEvent })
      });
      var d = await r.json();
      if (d.moved > 0 && d.failed > 0) showToast("Moved " + d.moved + ", failed " + d.failed);
      else if (d.moved > 0) showToast("Moved " + d.moved + " photo(s) to " + toEvent);
      else showToast(d.error || "Move failed");
    } catch(e) {
      showToast("Move failed");
    }
    selected.clear();
    await refreshManage();
  }
}

async function refreshManage() {
  if (_fetchingImages) await _fetchingImages;
  pageHistory = [];
  pageCursor = "";
  await fetchImages();
  updateAbCount();
}

function showToast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() { t.classList.remove("show"); }, 3000);
}

/* ── Photo modal ── */
// Track the current photo being shown in the modal so arrow keys can cycle
// through the full images[] array. _photoModalKind sticks with whatever the
// user clicked — if they opened the AI portrait, Left/Right cycles through
// AI portraits across neighboring spreads; if they opened the original
// selfie, cycles through originals.
var _photoModalIdx = -1;
var _photoModalKind = "portrait"; // "portrait" | "original"

function _srcForModal(img, kind) {
  return kind === "original" ? origUrl(img) : imgUrl(img);
}

function openPhotoModal(src, idx, kind) {
  var modal = document.getElementById("photoModal");
  var img = document.getElementById("photoModalImg");
  _photoModalIdx = (typeof idx === "number" && idx >= 0) ? idx : -1;
  _photoModalKind = kind === "original" ? "original" : "portrait";
  img.alt = _photoModalKind === "original" ? "Original selfie" : "Portrait";
  // Defensive: clear any stale flip state from a prior modal session.
  _isFlipping = false;
  img.classList.remove("flipping");
  img.src = src;
  modal.classList.add("open");
  document.addEventListener("keydown", _photoModalKeys);
}
function closePhotoModal(e) {
  if (e && e.target && e.target.tagName === "IMG") return;
  document.getElementById("photoModal").classList.remove("open");
  document.removeEventListener("keydown", _photoModalKeys);
  _photoModalIdx = -1;
  // Clear the flip guard so a new open session starts clean if the user
  // closed while a flip transition was in flight.
  _isFlipping = false;
  var el = document.getElementById("photoModalImg");
  if (el) el.classList.remove("flipping");
}
function cyclePhotoModal(delta) {
  // Needs an anchored index to cycle. If the modal was opened without a
  // known index (defensive — shouldn't happen via the delegated click
  // handler below, but keeps us safe against future callers), just bail.
  if (_photoModalIdx < 0 || !images.length) return;
  _photoModalIdx = (_photoModalIdx + delta + images.length) % images.length;
  var img = document.getElementById("photoModalImg");
  img.src = _srcForModal(images[_photoModalIdx], _photoModalKind);
  img.alt = _photoModalKind === "original" ? "Original selfie" : "Portrait";
}
function _photoModalKeys(e) {
  if (e.key === "Escape") { closePhotoModal(); return; }
  if (e.key === "ArrowRight") { cyclePhotoModal(1); e.preventDefault(); return; }
  if (e.key === "ArrowLeft") { cyclePhotoModal(-1); e.preventDefault(); return; }
  if (e.key === " " || e.code === "Space") { flipPhotoModal(); e.preventDefault(); return; }
}

// Toggle between the AI portrait and the original selfie with a 3D flip.
// If the image has hasSelfie === false, no flip happens (there's nothing
// on the back). The flip uses a CSS class on the img so the transform can
// animate; src swaps at the midpoint when the back face would be visible.
var _isFlipping = false;
function flipPhotoModal() {
  if (_isFlipping) return; // Ignore rapid re-presses — mid-flip.
  if (_photoModalIdx < 0 || !images.length) return;
  var img = images[_photoModalIdx];
  if (!img || img.hasSelfie === false) return;
  var el = document.getElementById("photoModalImg");
  if (!el) return;
  _isFlipping = true;
  var next = _photoModalKind === "portrait" ? "original" : "portrait";
  el.classList.add("flipping");
  setTimeout(function() {
    el.src = _srcForModal(img, next);
    el.alt = next === "original" ? "Original selfie" : "Portrait";
    _photoModalKind = next;
    setTimeout(function() {
      el.classList.remove("flipping");
      _isFlipping = false;
    }, 20);
  }, 180);
}

// Book images carry their current page index, so opening a portrait does not
// scan the entire page of photo metadata for a matching URL.
document.addEventListener("click", function(e) {
  var img = e.target;
  if (!img || img.tagName !== "IMG") return;
  var isPortrait = img.classList.contains("portrait");
  var isOriginal = img.classList.contains("original");
  if (!isPortrait && !isOriginal) return;
  e.stopPropagation();
  var kind = isOriginal ? "original" : "portrait";
  var idx = Number(img.dataset.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= images.length) return;
  openPhotoModal(img.src, idx, kind);
});

/* ── Milestone celebration ── */
function triggerMilestone(count) {
  if (typeof confetti === "function") {
    confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 }, colors: ["#EF223A", "#F83D53", "#FD7685", "#2188EF", "#fff"] });
    setTimeout(function() {
      confetti({ particleCount: 80, spread: 120, origin: { y: 0.5 }, colors: ["#EF223A", "#F83D53", "#FD7685", "#2188EF", "#fff"] });
    }, 300);
  }
  var banner = document.getElementById("milestoneBanner");
  var mod100 = count % 100, mod10 = count % 10;
  var suffix = (mod10 === 1 && mod100 !== 11) ? "st" : (mod10 === 2 && mod100 !== 12) ? "nd" : (mod10 === 3 && mod100 !== 13) ? "rd" : "th";
  banner.textContent = count + suffix + " Portrait!";
  banner.classList.remove("hide");
  banner.classList.add("show");
  setTimeout(function() {
    banner.classList.add("hide");
    setTimeout(function() { banner.classList.remove("show", "hide"); }, 500);
  }, 5000);
}

/* ── Init ── */
// Use pointerup — turn.js intercepts mousedown/click for page-drag gestures
document.getElementById("playPauseBtn").addEventListener("pointerup", function(e) {
  e.stopPropagation();
  e.preventDefault();
  togglePause();
});
document.getElementById("thumbs").addEventListener("scroll", updateThumbScrollButtons, { passive: true });
window.addEventListener("resize", updateThumbScrollButtons);
fetchEvents().then(function() { fetchImages(); });
function pollGallery() {
  if (document.hidden || manageMode) return;
  if (pageCursor) pollLatestTotal();
  else fetchImages();
}
setInterval(pollGallery, POLL_INTERVAL);
document.addEventListener("visibilitychange", function() {
  if (document.hidden) stopAuto();
  else {
    pollGallery();
    if (!paused && photoBookAutoplay && bookReady && !_holdingNewPhoto) startAuto();
  }
});
`;

function buildPageHtml(eventName, localeOverride, { adminNav = false } = {}) {
const settingsEvent = eventName === "all" ? settings.get("eventName") : eventName;
const locale = i18n.normalizeLocale(localeOverride) || i18n.resolveAttendeeLocale(settings.getForEvent("languageMode", settingsEvent)) || i18n.DEFAULT_LOCALE;
const pageBody = PAGE_BODY
  .replace('<div class="scene">', `<div class="scene${adminNav ? " admin-gallery" : ""}">`)
  .replace("{{SITE_NAV}}", adminNav ? renderSiteNav("gallery") : "")
  .replace("{{GALLERY_BRAND}}", adminNav
    ? '<span class="gallery-context-title">Photo book</span>'
    : '<span class="gallery-brand"><img src="/assets/icon-twilio-bug-red.svg" alt=""><span>Twilio <strong>Photo book</strong></span></span>');
let html = `<!DOCTYPE html>
<html lang="en" data-theme="dark"${adminNav ? ' class="gallery-admin-page"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t);if(window.top!==window)document.documentElement.classList.add('combo-embedded')})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Photo Book — Twilio Photobooth</title>
<link rel="stylesheet" href="/assets/twilio-brand.css">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/turn.js/3/turn.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"><\/script>
<style>${PAGE_CSS}
${brb.BRB_OVERLAY_CSS}
</style>
${adminNav ? siteNavStylesheet() : ""}
<link rel="stylesheet" href="/assets/gallery-workspace.css">
</head>
<body>
${pageBody}
` + brb.overlayHtml() + `
<script>${PAGE_JS}
${brb.BRB_OVERLAY_SCRIPT}
// BRB button
document.getElementById("brbBtn").addEventListener("click", function() { toggleBrb(); });
var displayMenu = document.getElementById("displayMenu");
displayMenu.addEventListener("click", function(event) {
  if (event.target.closest("button")) displayMenu.open = false;
});
document.addEventListener("pointerdown", function(event) {
  if (displayMenu.open && !displayMenu.contains(event.target)) displayMenu.open = false;
});
document.addEventListener("keydown", function(event) {
  if (event.key === "Escape" && displayMenu.open) {
    displayMenu.open = false;
    displayMenu.querySelector("summary").focus();
  }
});
</script>
</body>
</html>`;
if (locale === "pt_BR") {
  const replacements = [
    ['lang="en"', 'lang="pt-BR"'], ["Photo Book — Twilio Photobooth", ui.t(locale, "photoBookTitle")],
    ["Copy shareable link for this event", ui.t(locale, "copyLinkTitle")], [">Copy Link<", `>${ui.t(locale, "copyLink")}<`],
    [">Manage<", `>${ui.t(locale, "manage")}<`], [">Fullscreen<", `>${ui.t(locale, "fullscreen")}<`],
    [">Portrait previews<", ">Prévia dos retratos<"], ["Portrait previews", "Prévia dos retratos"],
    ["Scroll previews left", "Rolar prévias para a esquerda"], ["Scroll previews right", "Rolar prévias para a direita"],
    ["Pause slideshow", "Pausar apresentação"], ["Resume slideshow", "Retomar apresentação"],
    [">Event<", ">Evento<"], [">Display<", ">Exibição<"], ["Display controls", "Controles de exibição"],
    [">Be right back<", `>${ui.t(locale, "brb")}<`],
    ["Photo book</strong>", "Álbum de fotos</strong>"],
    ['class="gallery-context-title">Photo book<', 'class="gallery-context-title">Álbum de fotos<'],
    ["Manage portraits", "Gerenciar retratos"], ["Close portrait management", "Fechar gerenciamento de retratos"],
    ["Be right back display", "Exibir pausa"], ["Toggle light or dark theme", "Alternar tema claro ou escuro"],
    ["Toggle fullscreen", "Alternar tela cheia"],
    ["Previous page", "Página anterior"], ["Next page", "Próxima página"],
    ["Gallery pages", "Páginas da galeria"], [">Latest photos<", ">Fotos recentes<"],
    [">Newer photos<", ">Fotos mais recentes<"], [">Older photos<", ">Fotos mais antigas<"],
    [">Select page<", ">Selecionar página<"], [">Clear selection<", ">Limpar seleção<"],
    ["<h2>Manage portraits</h2>", "<h2>Gerenciar retratos</h2>"],
    ["Select photos to move or delete. Browse older photos in batches below.", "Selecione fotos para mover ou excluir. Navegue pelas fotos mais antigas abaixo."],
    ['"Showing " +', '"Exibindo " +'], ['" of " + galleryTotal', '" de " + galleryTotal'],
    ['" portraits"', '" retratos"'],
    ['"Ready for the first portrait"', '"Aguardando o primeiro retrato"'],
    ['"New portraits available"', '"Novos retratos disponíveis"'],
    ['"Latest photos"', '"Fotos recentes"'],
    ['"Gallery unavailable. Retrying…"', '"Galeria indisponível. Tentando novamente…"'],
    ["portraits created", ui.t(locale, "portraitsCreated")], ["Portraits will appear<br>as they are created&hellip;", "Os retratos aparecerão<br>conforme forem criados&hellip;"],
    [">Playing<", `>${ui.t(locale, "playing")}<`], ["All Events", ui.t(locale, "allEvents")],
    ["By participating, you agree to our terms of service: ", "Ao participar, você concorda com nossos termos de serviço: "],
    ["Link copied!", ui.t(locale, "linkCopied")], ["Paused", ui.t(locale, "paused")], ["Playing", ui.t(locale, "playing")],
    ["View Portrait", ui.t(locale, "viewPortrait")], ["View Original", ui.t(locale, "viewOriginal")],
    ["Original Photo Removed", ui.t(locale, "originalRemoved")], ["The original selfie has been deleted to protect the subject's privacy.", ui.t(locale, "privacyRemoved")],
    ["The original selfie has been deleted to protect the subject&#39;s privacy.", ui.t(locale, "privacyRemoved")],
    ["Previous photo", ui.t(locale, "previousPhoto")], ["Next photo", ui.t(locale, "nextPhoto")],
    ["Portrait viewer", "Visualizador de retratos"], ["Close portrait", "Fechar retrato"],
    ["Original selfie", "Selfie original"],
    ["banner.textContent = count + suffix + \" Portrait!\";", "banner.textContent = count + \"º retrato!\";"],
    ["We'll Be Right Back", ui.t(locale, "beRightBack")], ["click anywhere to dismiss", ui.t(locale, "dismiss")],
    [">BRB<", `>${ui.t(locale, "brb")}<`], [">Theme<", ">Tema<"],
  ];
  for (const [from, to] of replacements) html = html.split(from).join(to);
}
return html;
}


module.exports = { buildPageHtml };
