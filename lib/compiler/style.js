// lib/compiler/style.js — the static CSS: reset, layout engine, component skins,
// responsive ladder, interaction states. Zero AI, zero Date, zero randomness.
//
// DNA reaches this file ONLY through the token values interpolated at the marked
// spots (density -> section padding, breakpointLadder -> media queries, motion ->
// durations + reduced-motion block). Everything else is structural CSS that any
// well-built site needs and that carries no design identity.
'use strict';
const { esc } = require('./util.js');

function buildCss(tokens, dna, opts) {
    const layout = dna.layout || {};
    const density = layout.density === 'dense' ? 0.6 : layout.density === 'airy' ? 1.4 : 1;
    const padPx = Math.round(64 * density);                 // section vertical padding
    const padHeroPx = Math.round(padPx * 1.8);
    const mot = dna.motion || {};
    const dur = tokens['--motion-dur'] || '180ms';
    const ladder = (Array.isArray(layout.breakpointLadder) && layout.breakpointLadder.length)
        ? [...new Set(layout.breakpointLadder.filter((n) => Number.isFinite(n) && n >= 320 && n <= 2000))].sort((a, b) => a - b)
        : [640, 1024];
    const reduced = mot.honoursReducedMotion ? `
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}` : '';

    const mobileMq = `@media (max-width: ${Math.max(ladder[0] - 1, 480)}px)`;
    const tabletMq = ladder.length > 1 ? `@media (min-width: ${ladder[0]}px) and (max-width: ${ladder[ladder.length - 1]}px)` : null;

    return `*, *::before, *::after { box-sizing: border-box; margin: 0; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  background: var(--color-canvas); color: var(--color-text);
  font-family: var(--font-body); font-size: var(--text-base); line-height: 1.6;
  text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased;
}
img, svg { display: block; max-width: 100%; }
a { color: inherit; text-decoration: none; }
h1, h2, h3, h4 { font-family: var(--font-display); font-weight: 600; line-height: 1.15; letter-spacing: -0.01em; }
:focus-visible { outline: 2px solid var(--color-accent-text); outline-offset: 2px; border-radius: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: var(--space-md); top: -40px; z-index: 100; background: var(--color-canvas); color: var(--color-text); border: 1px solid var(--color-border); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-sm); transition: top var(--motion-dur); }
.skip-link:focus { top: var(--space-sm); }

.container { width: min(100% - (var(--space-lg) * 2), var(--layout-max)); margin-inline: auto; }
.container.narrow { width: min(100% - (var(--space-lg) * 2), calc(var(--layout-max) * 0.72)); }
.section { padding-block: ${padPx}px; }
.section-alt { background: var(--color-surface); }
.section-head { margin-bottom: var(--space-xl); }
.section-head h2 { font-size: var(--text-2xl); }
.section-lead { color: var(--color-text-muted); margin-top: var(--space-sm); max-width: 60ch; font-size: var(--text-lg); }
.grid { display: grid; gap: var(--space-lg); grid-template-columns: 1fr; }
.grid-cards { grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
.grid-stats { grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); text-align: center; }
.grid-tiles { grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); }

.site-header { position: sticky; top: 0; z-index: 50; background: var(--color-canvas); border-bottom: 1px solid var(--color-border); }
.header-inner { display: flex; align-items: center; gap: var(--space-lg); min-height: 64px; }
.brand { display: inline-flex; align-items: center; gap: var(--space-sm); font-family: var(--font-display); font-weight: 700; font-size: var(--text-lg); }
.brand-mark svg { width: 32px; height: 32px; }
.nav-links { display: flex; gap: var(--space-md); margin-inline-start: auto; }
.nav-link { color: var(--color-text-muted); font-size: var(--text-sm); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-sm); transition: color ${dur}, background-color ${dur}; }
.nav-link:hover { color: var(--color-text); background: var(--color-surface); }
.header-cta { display: flex; align-items: center; }
.nav-toggle { display: none; margin-inline-start: auto; background: none; border: 0; padding: var(--space-sm); cursor: pointer; }
.nav-toggle-bar, .nav-toggle-bar::before, .nav-toggle-bar::after { content: ''; display: block; width: 22px; height: 2px; background: var(--color-text); border-radius: 2px; position: relative; transition: transform ${dur}; }
.nav-toggle-bar::before { position: absolute; top: -7px; }
.nav-toggle-bar::after { position: absolute; top: 7px; }
.mobile-nav { display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md) var(--space-lg) var(--space-lg); border-bottom: 1px solid var(--color-border); background: var(--color-canvas); }
.mobile-nav[hidden] { display: none; }
${mobileMq} {
  .nav-links, .header-cta { display: none; }
  .nav-toggle { display: inline-flex; }
}
${tabletMq ? tabletMq + ` {\n  .grid-cards { grid-template-columns: repeat(2, 1fr); }\n}` : ''}

.hero { padding-block: ${padHeroPx}px ${padPx}px; }
.hero-inner { max-width: ${Math.round(72 * density)}ch; }
.eyebrow { color: var(--color-accent-text); text-transform: uppercase; letter-spacing: 0.08em; font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-md); }
.hero-heading { font-size: var(--text-3xl); }
.hero-sub { color: var(--color-text-muted); font-size: var(--text-lg); margin-top: var(--space-md); max-width: 58ch; }
.hero-actions { display: flex; flex-wrap: wrap; gap: var(--space-md); margin-top: var(--space-xl); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-sm); font-weight: 600; font-size: var(--text-base); line-height: 1; padding: var(--space-md) var(--space-lg); border-radius: var(--radius-md); border: 1px solid transparent; cursor: pointer; transition: transform ${dur}, box-shadow ${dur}, background-color ${dur}, color ${dur}; }
.btn:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn:active { transform: translateY(0); box-shadow: var(--shadow-sm); }
.btn-solid { background: var(--color-accent); color: var(--color-accent-ink); }
.btn-ghost { border-color: var(--color-border); color: var(--color-text); background: transparent; }
.btn-ghost:hover { background: var(--color-surface); }
.btn-sm { padding: var(--space-sm) var(--space-md); font-size: var(--text-sm); }

.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-xl); box-shadow: var(--shadow-sm); transition: border-color ${dur}, box-shadow ${dur}, transform ${dur}; }
.card:hover { border-color: var(--color-accent-text); box-shadow: var(--shadow-lg); transform: translateY(-2px); }
.card h3 { font-size: var(--text-xl); margin-bottom: var(--space-sm); }
.card p { color: var(--color-text-muted); }
.feature-list { list-style: none; display: grid; gap: var(--space-md); }
.feature-row { display: flex; gap: var(--space-lg); padding: var(--space-lg); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-canvas); transition: border-color ${dur}; }
.feature-row:hover { border-color: var(--color-accent-text); }
.feature-row h3 { font-size: var(--text-lg); margin-bottom: var(--space-xs); }
.feature-row p { color: var(--color-text-muted); }
.stat { padding: var(--space-lg); }
.stat-value { display: block; font-family: var(--font-display); font-size: var(--text-3xl); color: var(--color-accent-text); }
.stat-label { color: var(--color-text-muted); font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; }
.pull-quote { max-width: 64ch; margin-inline: auto; text-align: center; }
.pull-quote p { font-family: var(--font-display); font-size: var(--text-xl); line-height: 1.4; }
.pull-quote figcaption { margin-top: var(--space-md); color: var(--color-text-muted); font-size: var(--text-sm); }
.tile { border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-canvas); }
.tile-art { aspect-ratio: 16 / 10; background: linear-gradient(135deg, var(--color-surface), var(--color-surface-alt)); }
.tile-art[data-tile='1'] { background: linear-gradient(135deg, var(--color-surface-alt), var(--color-border)); }
.tile-art[data-tile='2'] { background: linear-gradient(225deg, var(--color-surface-alt), var(--color-surface)); }
.tile figcaption { padding: var(--space-md); font-size: var(--text-sm); color: var(--color-text-muted); }
.prose { max-width: 65ch; color: var(--color-text-muted); font-size: var(--text-lg); }
.prose + .prose { margin-top: var(--space-md); }
.section-cta { text-align: center; }
.cta-inner { display: grid; gap: var(--space-md); justify-items: center; }
.cta-inner h2 { font-size: var(--text-2xl); }
.cta-inner p { color: var(--color-text-muted); max-width: 52ch; }

.site-footer { border-top: 1px solid var(--color-border); padding-block: var(--space-2xl) var(--space-xl); background: var(--color-surface); }
.foot-grid { display: grid; grid-template-columns: 2fr repeat(3, 1fr); gap: var(--space-xl); }
.foot-brand p { color: var(--color-text-muted); margin-top: var(--space-md); max-width: 34ch; font-size: var(--text-sm); }
.foot-col h4 { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-md); }
.foot-link { display: block; color: var(--color-text-muted); font-size: var(--text-sm); padding-block: calc(var(--space-xs) / 2); transition: color ${dur}; }
.foot-link:hover { color: var(--color-text); }
.foot-fine { margin-top: var(--space-xl); padding-top: var(--space-md); border-top: 1px solid var(--color-border); color: var(--color-text-muted); font-size: var(--text-sm); }
@media (max-width: 720px) { .foot-grid { grid-template-columns: 1fr 1fr; } }
${mobileMq} { .foot-grid { grid-template-columns: 1fr; } }
${reduced}`.replace(/\n{3,}/g, '\n\n');
}

// The interaction layer: ONE delegated listener script, fixed text.
const JS = `(function () {
  'use strict';
  var toggle = document.querySelector('.nav-toggle');
  var mnav = document.getElementById('mnav');
  if (toggle && mnav) {
    toggle.addEventListener('click', function () {
      var open = mnav.hidden;
      mnav.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    mnav.addEventListener('click', function (e) {
      if (e.target.closest('a')) { mnav.hidden = true; toggle.setAttribute('aria-expanded', 'false'); }
    });
  }
  var links = document.querySelectorAll('.nav-link, .brand');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function () {
      if (mnav && !mnav.hidden) { mnav.hidden = true; if (toggle) toggle.setAttribute('aria-expanded', 'false'); }
    });
  }
})();`;

module.exports = { buildCss, JS };
