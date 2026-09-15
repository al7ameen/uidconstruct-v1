// tests/compiler.test.js — P3: DesignDNA + ContentSpec + UserBrand -> GeneratedSite.
//
// Harness rules inherited from this project's recorded failures (same as
// dna.test.js): executed-count asserted, ONLY= filter must match or dies,
// duplicate names die, no pipes, nonzero exit on any failure. The I-series
// additionally MUTATES the compiler source in a child process and requires the
// targeted tests to go RED — a green firewall that cannot fail is theatre.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { buildDesignFacts } = require(path.join(ROOT, 'lib/facts.js'));
const { buildProjection } = require(path.join(ROOT, 'lib/projection.js'));
const { factsHash, sha256 } = require(path.join(ROOT, 'lib/canonical.js'));
const { buildForbidden, makeScanner } = require(path.join(ROOT, 'lib/identity.js'));
const F = require(path.join(__dirname, 'fixtures/dna-zephyrion.js'));
const { compileSite, assemble, IdentityLeakError, ContentInvalidError, SENTINEL } = require(path.join(ROOT, 'lib/compiler/index.js'));
const { validateContent } = require(path.join(ROOT, 'lib/compiler/content-schema.js'));
const { compileTokens } = require(path.join(ROOT, 'lib/compiler/tokens.js'));
const { resolveBrand, monogram } = require(path.join(ROOT, 'lib/compiler/brand.js'));
const { Button } = require(path.join(ROOT, 'lib/compiler/components.js'));

const clone = (o) => JSON.parse(JSON.stringify(o));

function makeCtx() {
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const built = buildProjection(facts);
    built.projection.factsHash = factsHash(facts);
    built.projection.model = 'qwen3.8-flash';
    const dna = F.validDnaFrom({ projection: built.projection, factsHash: built.projection.factsHash });
    const scan = makeScanner(buildForbidden(facts));
    return { facts, dna, scan };
}
const CTX = makeCtx();

// Valid-ish ContentSpec used by most tests. No reference tokens in it (the
// reference in fixtures is 'zephyrion'); brand 'KiteStack' is deliberate.
function contentFixture() {
    return {
        schema: 'contentspec/1',
        brand: { name: 'KiteStack', tagline: 'AI tools for developers' },
        nav: {
            items: [{ label: 'Features', href: '#features' }, { label: 'Numbers', href: '#numbers' }],
            cta: { label: 'Get started', href: '#start' },
        },
        hero: { heading: 'Build at the speed of thought', sub: 'KiteStack turns intent into shipped software.',
            ctas: [{ label: 'Start free', kind: 'primary', href: '#start' }] },
        sections: [
            { id: '#features', type: 'FEATURE_GRID', title: 'Everything you need', items: [{ title: 'Fast', body: 'Minutes, not sprints.' }, { title: 'Safe', body: 'Typed end to end.' }] },
            { id: '#numbers', type: 'STATS', title: 'Trusted', items: [{ value: '10k+', label: 'developers' }] },
            { id: '#start', type: 'CTA', title: 'Ready?', items: [{ heading: 'Start today', body: 'Free while in beta.' }] },
        ],
        footer: { blurb: 'The fastest way from idea to production.' },
    };
}
function brandFixture() { return { name: 'KiteStack', tagline: 'AI tools for developers', logo: { mode: 'generated' } }; }
const compile = (dna, content, brand, scan) => compileSite(dna || CTX.dna, content || contentFixture(), brand || brandFixture(), { scan: scan || CTX.scan });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- A: input gates ---------------------------------------------------------
test('A1 rejects non-DNA input', () => {
    assert.throws(() => compileSite({ schema: 'x' }, contentFixture(), brandFixture(), { scan: CTX.scan }), /designdna\/1/);
});
test('A2 scan argument is REQUIRED', () => {
    assert.throws(() => compileSite(CTX.dna, contentFixture(), brandFixture(), {}), /firewall is not optional/);
    assert.throws(() => compileSite(CTX.dna, contentFixture(), brandFixture()), /firewall is not optional/);
});
test('A3 ContentSpec re-validated by compiler', () => {
    const bad = contentFixture(); delete bad.hero.sub;
    assert.throws(() => compile(CTX.dna, bad, brandFixture()), ContentInvalidError);
});
test('A4 structural DNA identity fails fast', () => {
    const d = clone(CTX.dna); d.identity.referenceName = 'zephyrion';
    assert.throws(() => compile(d, contentFixture(), brandFixture()), (e) => e instanceof IdentityLeakError && e.layer === 'dna.identity');
});

// ---- B: content schema --------------------------------------------------------
test('B1 valid spec passes', () => assert.strictEqual(validateContent(contentFixture()).ok, true));
test('B2 external href rejected by schema', () => {
    const c = contentFixture(); c.nav.items[0].href = 'https://elsewhere.example/x';
    assert.strictEqual(validateContent(c).ok, false);
});
test('B3 unknown top-level key rejected', () => {
    const c = contentFixture(); c.markup = '<div>';
    assert.strictEqual(validateContent(c).ok, false);
});
test('B4 unknown section type rejected', () => {
    const c = contentFixture(); c.sections[0].type = 'SLIDESHOW';
    assert.strictEqual(validateContent(c).ok, false);
});
test('B5 per-type item shapes enforced (discriminated union)', () => {
    const c = contentFixture(); c.sections[1].items[0] = { title: 'wrong for STATS', body: 'x' };
    const r = validateContent(c);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /value: missing/.test(e)), r.errors.join(';'));
});
test('B6 in-page anchors pass', () => {
    const c = contentFixture(); c.nav.items[0].href = '#a_b-C1'; c.nav.items[1].href = '#d-2_E';
    assert.strictEqual(validateContent(c).ok, true);
});
test('B7 oversized text rejected', () => {
    const c = contentFixture(); c.hero.heading = 'x'.repeat(91);
    assert.strictEqual(validateContent(c).ok, false);
});

// ---- C: token compiler -------------------------------------------------------
test('C1 tokens deterministic + valid css block', () => {
    const a = compileTokens(CTX.dna);
    assert.strictEqual(a.css, compileTokens(CTX.dna).css);
    assert.ok(a.css.startsWith(':root {') && a.css.endsWith('\n}'));
    assert.ok(/--color-canvas: #/.test(a.css));
});
test('C2 type scale strictly monotonic for every hierarchy', () => {
    for (const h of ['modular', 'fluid', 'stepped']) {
        const d = clone(CTX.dna); d.typography.hierarchy = h;
        const t = compileTokens(d).tokens;
        const n = (k) => parseFloat(t[k]);
        assert.ok(n('text-sm') < n('text-base') && n('text-base') < n('text-lg') && n('text-lg') < n('text-xl') && n('text-xl') < n('text-2xl') && n('text-2xl') < n('text-3xl'), h + ' not monotonic');
    }
});
test('C3 stepped ladder coarser than modular for ratio>1', () => {
    const span = (h) => { const d = clone(CTX.dna); d.typography.hierarchy = h; const t = compileTokens(d).tokens; return parseFloat(t['text-3xl']) / parseFloat(t['text-base']); };
    assert.ok(span('stepped') > span('modular'));
});
test('C4 low-contrast text roles nudged, adjustment reported', () => {
    const d = clone(CTX.dna);
    d.palette.roles = [
        { role: 'canvas', value: '#0a0a0a' }, { role: 'text', value: '#f5f5f5' },
        { role: 'accent', value: '#2b2b2b' },   // dark-grey accent: unusable as text
    ];
    const r = compileTokens(d);
    const adj = r.adjustments.map((a) => a.role);
    assert.ok(adj.includes('accent-text'), JSON.stringify(r.adjustments));
    const at = r.tokens['color-accent-text'];
    const { contrast } = require(path.join(ROOT, 'lib/compiler/util.js'));
    assert.ok(contrast(at, '#0a0a0a') >= 3.0, at);
});
test('C5 dark canvas gets dark-theme shadows, light gets light', () => {
    const d = clone(CTX.dna);
    d.palette.roles = [{ role: 'canvas', value: '#0a0a0a' }, { role: 'text', value: '#f5f5f5' }];
    assert.ok(compileTokens(d).tokens['shadow-sm'].includes('0.6'));
    assert.ok(compileTokens(CTX.dna).tokens['shadow-sm'].includes('0.08'));
});
test('C6 font stacks contain no family names from facts', () => {
    const css = compileTokens(CTX.dna).css;
    for (const fam of (CTX.facts.type.families || [])) {
        const raw = String(fam && (fam.raw || fam.name || '')).toLowerCase().trim();
        if (raw.length > 2) assert.ok(!css.toLowerCase().includes(raw), raw);
    }
});
test('C7 out-of-range baseUnit falls back to 8', () => {
    const d = clone(CTX.dna); d.spacing.baseUnit = 4000;
    assert.ok(compileTokens(d).css.includes('--space-md: 8px;'));
});
test('C8 radius posture pill + no values -> 999 lg; sharp -> zeros', () => {
    const d = clone(CTX.dna); d.radius = { status: 'unavailable', posture: 'pill', values: [] };
    assert.ok(compileTokens(d).css.includes('--radius-lg: 999px;'));
    d.radius.posture = 'sharp';
    assert.ok(compileTokens(d).css.includes('--radius-md: 0px;'));
});
test('C9 missing scaleRatio falls back to 1.2', () => {
    const d = clone(CTX.dna); d.typography.scaleRatio = null;
    assert.ok(compileTokens(d).css.includes('--text-lg: 19.2px;'));
});

// ---- D: components/render ----------------------------------------------------
test('D1 html escapes markup in every text slot', () => {
    const c = contentFixture();
    c.hero.heading = '<img src=x onerror=alert(1)>';
    c.nav.items[0].label = '"><script>bad()</script>';
    c.hero.ctas[0].label = '<i>Start</i>';   // rendered by Button()
    c.sections[0].items[0].title = '&amp;tricky';
    const site = compile(CTX.dna, c, brandFixture());
    assert.ok(site.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'heading not escaped');
    assert.ok(!/<img src=x/.test(site.html), 'raw injected img tag shipped');
    assert.ok(!/"><script>bad\(\)/.test(site.html), 'attribute breakout shipped');
    assert.ok(site.html.includes('&amp;amp;tricky'), 'input entities get escaped exactly once');
    const tsite = compile(CTX.dna, contentFixture(), { name: '<b>Bad</b>' });
    assert.ok(!tsite.html.includes('<title><b>Bad</b></title>'), 'brand name reached <title> unescaped');
    assert.ok(tsite.html.includes('&lt;b&gt;Bad&lt;/b&gt;'), 'escaped form missing');
    // the mutated Button label lives in `c` -> `site`, not the title-only tsite
    assert.ok(!site.html.includes('><i>Start</i><'), 'Button label reached html raw');
    assert.ok(site.html.includes('&lt;i&gt;Start&lt;/i&gt;'), 'Button label not escaped');
});
test('D2 safeHref kills executable schemes; https passes (schema owns the anchor policy)', () => {
    assert.ok(Button({ label: 'x', href: 'javascript:alert(1)' }).includes('href="#"'));
    assert.ok(Button({ label: 'x', href: 'data:text/html,<b>' }).includes('href="#"'));
    assert.ok(Button({ label: 'x', href: '//evil.example' }).includes('href="#"'), 'protocol-relative dropped');
    const ok2 = Button({ label: 'x', href: 'https://kite.example' });
    assert.ok(ok2.includes('href="https://kite.example"'), ok2);
    // and compile() end-to-end: an https href can only arrive by bypassing the
    // schema — B2 owns that gate; here we pin the layer contract only.
});
test('D3 all hrefs in shipped html are anchors or safe', () => {
    const site = compile();
    const bad = (site.html.match(/href="([^"]*)"/g) || []).map((m) => m.slice(6, -1))
        .filter((h) => !(h.startsWith('#') || h.startsWith('https://') || h === '#'));
    assert.deepStrictEqual(bad, []);
});
test('D4 every section type renders', () => {
    const c = contentFixture();
    c.sections = [
        { id: '#a', type: 'FEATURE_GRID', title: 'g', items: [{ title: 't', body: 'b' }] },
        { id: '#b', type: 'FEATURE_LIST', title: 'l', items: [{ title: 't', body: 'b' }] },
        { id: '#c', type: 'STATS', title: 's', items: [{ value: '1', label: 'l' }] },
        { id: '#d', type: 'QUOTE', title: 'q', items: [{ text: 't', cite: 'c' }] },
        { id: '#e', type: 'GALLERY', title: 'e', items: [{ title: 'shot' }] },
        { id: '#f', type: 'TEXT', title: 'f', items: [{ body: 'para' }] },
        { id: '#g', type: 'CTA', title: 'c', items: [{ heading: 'h', body: 'b' }] },
    ];
    const site = compile(CTX.dna, c, brandFixture());
    for (const id of ['#a', '#b', '#c', '#d', '#e', '#f', '#g']) assert.ok(site.html.includes(`id="${id.slice(1)}"`), id);
    assert.ok(site.html.includes('<blockquote'), 'QUOTE');
    assert.ok(site.html.includes('tile-art'), 'GALLERY placeholder tiles (no imagery)');
});
test('D5 unmapped type reaching Sections throws (defense in depth)', () => {
    const { Sections } = require(path.join(ROOT, 'lib/compiler/components.js'));
    assert.throws(() => Sections([{ id: '#x', type: 'WEIRD', title: 't', items: [] }]), /unmapped section type/);
});
test('D6 nav toggle + aria wiring present', () => {
    const site = compile();
    assert.ok(site.html.includes('class="nav-toggle"'));
    assert.ok(site.html.includes('aria-expanded="false"'));
    assert.ok(site.js.includes("setAttribute('aria-expanded'"));
    assert.ok(site.html.includes('<a class="skip-link" href="#top">'));
});
test('D7 CTA button reuses nav cta label, invents no copy', () => {
    const c = contentFixture();
    const site = compile(CTX.dna, c, brandFixture());
    assert.ok(/section-cta[\s\S]*Get started/.test(site.html));
    const c2 = contentFixture(); delete c2.nav.cta;
    assert.ok(!/section-cta[\s\S]*Get started/.test(compile(CTX.dna, c2, brandFixture()).html));
});

// ---- E: brand + logo ---------------------------------------------------------
test('E1 generated monogram deterministic + name-sensitive', () => {
    const t = { 'color-accent': '#3d5afe', 'color-accent-ink': '#fff', 'radius-md': '10px' };
    assert.strictEqual(monogram('KiteStack', t), monogram('KiteStack', t));
    assert.notStrictEqual(monogram('KiteStack', t), monogram('BlueHarbor', t));
});
test('E2 unicode brand names use first code point', () => {
    const r = resolveBrand({ name: 'മലയാളം കോഡ്‌', logo: { mode: 'generated' } }, {});
    assert.ok(r.logoHtml.includes('മ'), r.logoHtml.slice(0, 200));
});
test('E3 upload png -> logo.png asset + img tag', () => {
    const d = 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64');
    const r = resolveBrand({ name: 'K', logo: { mode: 'upload', dataUrl: d, alt: 'Our mark' } }, {});
    assert.strictEqual(r.logoAsset.path, 'assets/logo.png');
    assert.ok(r.logoHtml.startsWith('<img class="brand-logo"'));
});
test('E4 malformed / oversized uploads rejected', () => {
    assert.throws(() => resolveBrand({ name: 'K', logo: { mode: 'upload', dataUrl: 'javascript:alert(1)' } }, {}), /data: image URL/);
    const big = 'data:image/png;base64,' + 'A'.repeat(210 * 1024);
    assert.throws(() => resolveBrand({ name: 'K', logo: { mode: 'upload', dataUrl: big } }, {}), /200KB/);
});
test('E5 evil uploaded svg rejected by DECODED scan', () => {
    const evil = 'data:image/svg+xml;base64,' + Buffer.from('<svg><circle onload="alert(1)"/></svg>').toString('base64');
    assert.throws(() => resolveBrand({ name: 'K', logo: { mode: 'upload', dataUrl: evil } }, {}), /rejected/);
    // and it must fail the same way through the full compiler
    const brand = { name: 'K', logo: { mode: 'upload', dataUrl: evil } };
    assert.throws(() => compile(CTX.dna, contentFixture(), brand), /rejected/);
});
test('E6 brand name missing throws', () => {
    assert.throws(() => resolveBrand({ name: '   ' }, {}), /UserBrand.name is required/);
});

// ---- F: identity firewall ----------------------------------------------------
test('F1 tier1: reference token in content data throws', () => {
    const c = contentFixture(); c.hero.sub = 'like zephyrion but faster';
    assert.throws(() => compile(CTX.dna, c, brandFixture()), IdentityLeakError);
    // layer pinned separately so a mutant that removes tier 1 is visibly a
    // different failure (defense-in-depth report), not a hidden pass.
    assert.throws(() => compile(CTX.dna, c, brandFixture()), (e) => e.layer === 'content/brand data');
});
test('F2 tier1: reference token in UserBrand throws', () => {
    const b = { name: 'Zephyrion Fans Unite' };
    assert.throws(() => compile(CTX.dna, contentFixture(), b), (e) => e.layer === 'content/brand data');
});
test('F3 tier2: encoded svg payload IS decoded before scanning', () => {
    // Reference token smuggled into an SVG asset's base64 (the vector the scan
    // would miss if it only looked at the encoded string). Synthetic scanner
    // stands in for the forbidden set so the test proves the decode, not the fixture.
    const refToken = 'glarbax';
    const scan = (s) => new Set(String(s).toLowerCase().includes(refToken) ? [refToken] : []);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${refToken}</text></svg>`;
    const d = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const brand = { name: 'K', logo: { mode: 'upload', dataUrl: d } };
    assert.throws(() => compile(CTX.dna, contentFixture(), brand, scan), (e) => e instanceof IdentityLeakError && e.layer === 'rendered site');
});
test('F4 sentinel-collision refused by tier1 (baseline purity)', () => {
    const scan = (s) => new Set(String(s).toLowerCase().includes(SENTINEL.toLowerCase()) ? [SENTINEL.toLowerCase()] : []);
    const c = contentFixture(); c.hero.heading = 'powered by ' + SENTINEL;
    assert.throws(() => compile(CTX.dna, c, brandFixture(), scan), (e) => e.layer === 'content/brand data');
});
test('F5 structure vocabulary never trips the firewall (over-strict trap)', () => {
    // Reference brand literally named after CSS words we emit structurally.
    const scan = makeScanner({ forbidden: new Set(['focus', 'sticky', 'button']), literals: [] });
    const site = compile(CTX.dna, contentFixture(), brandFixture(), scan);
    assert.ok(site.identityScan.passed);
});
test('F6 DNA prose never reaches render (Tier-2 dependency pinned)', () => {
    const marker = 'ZephyrionIsMentionedHereNow';
    const d = clone(CTX.dna);
    d.principles[0] = marker;
    d.voice.structuralLabels = [marker];
    d.components.idioms = [{ kind: 'card', pattern: marker }];
    const c = contentFixture(); c.sections[1].items[0] = { value: '10k', label: 'devs' }; // untouched
    const site = compile(d, c, brandFixture(), (s) => new Set(String(s).includes(marker) ? [marker] : []));
    assert.ok(!site.html.includes(marker));
});
test('F7 shipped site: zero reference tokens for real forbidden set', () => {
    const site = compile();
    const hits = CTX.scan([site.html, site.css, site.js].join('\n') + Buffer.from(site.assets[0].dataUrl.split(',')[1], 'base64').toString());
    assert.deepStrictEqual([...hits], []);
});

// ---- G: determinism (byte-identical, not vibe-identical) ---------------------
const digest = (site) => sha256([site.html, site.css, site.js, site.assets.map((a) => a.path + a.mime + a.dataUrl).join('|')].join('§'));
test('G1 same inputs -> identical bytes across 5 compiles (fresh objects each time)', () => {
    const h = new Set();
    for (let i = 0; i < 5; i++) h.add(digest(compile(clone(CTX.dna), contentFixture(), brandFixture(), CTX.scan)));
    assert.strictEqual(h.size, 1);
});
test('G2 key-order of inputs irrelevant (canonical determinism)', () => {
    const a = digest(compile(CTX.dna, contentFixture(), { tagline: 'AI tools for developers', name: 'KiteStack', logo: { mode: 'generated', dataUrl: null } }, CTX.scan));
    const b = digest(compile(CTX.dna, contentFixture(), brandFixture(), CTX.scan));
    assert.strictEqual(a, b, 'property insertion order changed output');
});
test('G3 different inputs -> different bytes (determinism is not a constant)', () => {
    const base = digest(compile());
    const c2 = contentFixture(); c2.hero.heading = 'Another heading';
    assert.notStrictEqual(digest(compile(CTX.dna, c2, brandFixture(), CTX.scan)), base);
    const d2 = clone(CTX.dna); d2.layout.maxWidth = 980;
    assert.notStrictEqual(digest(compile(d2, contentFixture(), brandFixture(), CTX.scan)), base);
});

// ---- H: site/1 contract ------------------------------------------------------
test('H1 keys exactly per site/1 contract', () => {
    const site = compile();
    assert.deepStrictEqual(Object.keys(site).sort(), ['assets', 'css', 'generator', 'html', 'identityScan', 'js', 'meta', 'schema'].sort());
    assert.strictEqual(site.schema, 'site/1');
    assert.ok(/^uidconstruct-v1\//.test(site.generator));
});
test('H2 css+js embedded in html AND present as fields', () => {
    const site = compile();
    assert.ok(site.html.includes('<style>') && site.html.indexOf(site.css.slice(200, 260)) > -1);
    assert.ok(site.html.includes('<script>') && site.html.includes(site.js.slice(50, 110)));
});
test('H3 assets: exactly the logo, correct path for mode', () => {
    const gen = compile();
    assert.strictEqual(gen.assets.length, 1);
    assert.strictEqual(gen.assets[0].path, 'assets/logo.svg');
    assert.strictEqual(gen.assets[0].mime, 'image/svg+xml');
});
test('H4 meta carries title/description/adjustments; never silent', () => {
    const site = compile();
    assert.strictEqual(site.meta.title, 'KiteStack — AI tools for developers');
    assert.ok(Array.isArray(site.meta.adjustments));
});

// ---- I: responsive + motion rules -------------------------------------------
test('I1 breakpoint ladder drives the media queries', () => {
    const site = compile();
    const ladder = CTX.dna.layout.breakpointLadder; // [640,768,1024,1280]
    assert.ok(site.css.includes(`@media (max-width: ${ladder[0] - 1}px)`), 'mobile mq from ladder[0]');
    assert.ok(site.css.includes(`@media (min-width: ${ladder[0]}px) and (max-width: ${ladder[ladder.length - 1]}px)`), 'tablet span first->last');
});
test('I2 empty ladder falls back to sane defaults', () => {
    const d = clone(CTX.dna); d.layout.breakpointLadder = [];
    const css = compile(d, contentFixture(), brandFixture(), (s) => new Set()).css;
    assert.ok(css.includes('@media (max-width: 639px)') || css.includes('@media (max-width: 479px)'), 'fallback ladder');
});
test('I3 honoursReducedMotion true -> reduce block present; false -> absent', () => {
    assert.ok(compile().css.includes('@media (prefers-reduced-motion: reduce)'));
    const d = clone(CTX.dna); d.motion.honoursReducedMotion = false;
    assert.ok(!compile(d, contentFixture(), brandFixture(), CTX.scan).css.includes('prefers-reduced-motion'));
});
test('I4 density drives section padding, monotonic in all three settings', () => {
    const padFor = (density) => {
        const d = clone(CTX.dna); d.layout.density = density;
        const m = /\.section \{ padding-block: (\d+)px/.exec(compile(d, contentFixture(), brandFixture(), (s) => new Set()).css);
        return Number(m[1]);
    };
    const airy = padFor('airy'), normal = padFor('balanced'), dense = padFor('dense');
    assert.ok(airy > normal && normal > dense, `${airy}/${normal}/${dense}`);
});
test('I5 motion duration flows from DNA into transitions', () => {
    assert.ok(compile().css.includes('--motion-dur: 200ms;'));
    const d = clone(CTX.dna); d.motion.durationsMs = [420, 500];
    assert.ok(compile(d, contentFixture(), brandFixture(), (s) => new Set()).css.includes('transition: color 420ms, background-color 420ms'));
});

// ---- J: tokens/ids sanity ----------------------------------------------------
test('J1 every var(--token) used in css/js/html is declared', () => {
    const site = compile();
    const declared = new Set((site.css.match(/--[\w-]+(?=:)/g) || []));
    const used = new Set((site.html.match(/var\((--[\w-]+)[),]/g) || []).map((m) => /var\((--[\w-]+)/.exec(m)[1]));
    const missing = [...used].filter((u) => !declared.has(u));
    assert.deepStrictEqual(missing, [], 'undeclared custom properties shipped');
});
test('J2 section ids unique, skip-link and nav ctas resolve to real anchors', () => {
    const c = contentFixture();
    const site = compile(CTX.dna, c, brandFixture(), CTX.scan);
    const ids = new Set((site.html.match(/<article[^>]*id="([^"]+)"/g) || []).map((m) => /id="([^"]+)"/.exec(m)[1]));
    ids.add('top');
    const hrefs = new Set((site.html.match(/href="#([^"]+)"/g) || []).map((m) => /href="#([^"]+)"/.exec(m)[1]));
    const dead = [...hrefs].filter((h) => !ids.has(h));
    assert.deepStrictEqual(dead, [], 'links to non-existent anchors shipped (unresolved_links_bug_class)');
});

// ---- M: mutation verification (child processes; source never touched) --------
// Each entry: exact literal to replace (appears ONCE — asserted), the mutated
// form, and the tests that MUST go red. If the mutant leaves everything green,
// the guard cannot fail and this suite reports a failure — that is the entire
// point of the M series: 'green' here means 'proven able to go red'.
const MUTATIONS = [
    { name: 'M1 tier1-scan-removed', file: 'lib/compiler/index.js',
      find: `    if (t1 && t1.size) throw new IdentityLeakError('content/brand data', [...t1]);`,
      to: `    // mutated: tier 1 disabled`, expect: ['F1 ', 'F2 ', 'F4 '] },
    { name: 'M2 asset-not-decoded', file: 'lib/compiler/index.js',
      find: `? Buffer.from(String(a.dataUrl).split('base64,')[1] || '', 'base64').toString('latin1')`,
      to: `? String(a.dataUrl)`, expect: ['F3 '] },
    { name: 'M3 baseline-exemption-removed', file: 'lib/compiler/index.js',
      find: `const t2 = new Set([...(o.scan(wire) || [])].filter((t) => !baseline.has(t)));`,
      to: `const t2 = new Set(o.scan(wire) || []);`, expect: ['F5 '] },
    { name: 'M4 dna-identity-check-removed', file: 'lib/compiler/index.js',
      find: `    if (dna.identity && (dna.identity.referenceName !== null || dna.identity.referenceDomain !== null)) {`,
      to: `    if (false) {`, expect: ['A4 '] },
    { name: 'M5 upload-svg-scan-removed', file: 'lib/compiler/brand.js',
      find: `if (SVG_UNSAFE.test(decoded)) throw new Error('uploaded SVG contains script/handler/external-ref patterns; rejected');`,
      to: `/* mutated: scan removed */`, expect: ['E5 '] },
    { name: 'M6 label-escape-removed', file: 'lib/compiler/components.js',
      find: `return \`<a class="\${cls}" href="\${safeHref(item.href)}">\${esc(item.label)}</a>\`;`,
      to: `return \`<a class="\${cls}" href="\${safeHref(item.href)}">\${item.label}</a>\`;`, expect: ['D1 '] },
    { name: 'M7 render-escapes-raw-input', file: 'lib/compiler/index.js',
      find: `        \`<a class="skip-link" href="#top">Skip to content</a>\`,`[0] === '`' ? '`<a class="skip-link" href="#top">Skip to content</a>`,' : '',
      to: '', expect: [] }, // placeholder replaced below
    { name: 'M9 contrast-fix-noop', file: 'lib/compiler/tokens.js',
      find: `    if (contrast(fg, bg) >= target) return { value: fg, adjusted: false };`,
      to: `    if (true) return { value: fg, adjusted: false };`, expect: ['C4 '] },
    { name: 'M10 reduced-motion-always-on', file: 'lib/compiler/style.js',
      find: `    const reduced = mot.honoursReducedMotion ? \``,
      to: `    const reduced = true ? \``, expect: ['I3 '] },
    { name: 'M11 determinism: hash variant by time', file: 'lib/compiler/brand.js',
      find: `    const variant = hashInt('monogram:' + name, 2);`,
      to: `    const variant = Math.random() < 0.5 ? 0 : 1;`, expect: ['G'] } // ONLY=G runs G1-G3
];
// M7 real payload: swap esc(title) -> title in the <title> template
MUTATIONS[6] = { name: 'M7 title-escape-removed', file: 'lib/compiler/index.js',
    find: `<title>\${esc(title)}</title>`, to: `<title>\${title}</title>`, expect: ['D1 '] };

// Exact-literal anchors must appear ONCE, or the mutation tests the wrong thing.
test('M0 mutation anchors appear exactly once in their files', () => {
    for (const m of MUTATIONS) {
        const src = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
        const count = src.split(m.find).length - 1;
        assert.strictEqual(count, 1, `${m.name}: anchor found ${count}x in ${m.file}`);
    }
});

for (const m of MUTATIONS) {
    test(m.name, () => {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mut-'));
        // copy repo minus node_modules (symlink it) — child needs full lib tree
        const files = ['lib', 'tests'];
        for (const d of files) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
        const target = path.join(tmp, m.file);
        const src = fs.readFileSync(target, 'utf8');
        assert.strictEqual(src.split(m.find).length - 1, 1);
        fs.writeFileSync(target, src.replace(m.find, m.to));
        let out = '';
        let code = 0;
        try {
            // Run the FULL suite (minus mutation tests) in the mutant: every guard
            // that the mutation breaks must show up, and nothing else may break.
            out = execFileSync(process.execPath, [path.join(tmp, 'tests/compiler.test.js'), '--no-mutate'],
                { encoding: 'utf8', env: { ...process.env, ONLY: '' }, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            code = e.status === undefined ? -1 : e.status;
            out = String(e.stdout || '') + String(e.stderr || '');
        }
        if (code === 0) {
            // child green while mutated -> the guard cannot fail
            // ONLY= must have matched; if it ran 0 tests the harness would have died nonzero.
            assert.fail(`MUTANT SURVIVED: with ${m.file} mutated (${m.name}), tests [${m.expect.join(', ')}] still passed`);
        }
        const failedNames = out.split('\n').filter((l) => l.startsWith('  FAIL ')).map((l) => l.slice(7).trim());
        for (const want of m.expect) {
            assert.ok(failedNames.some((nm) => nm.startsWith(want.trim())),
                `mutant ${m.name}: expected red on "${want}", but only [${failedNames.join(' | ') || 'nothing'}] failed`);
        }
    });
}

// ---- runner (same conventions as dna.test.js) --------------------------------
const started = Date.now();
const NO_MUTATE = process.argv.includes('--no-mutate');
(async function () {
    let pass = 0;
    const fails = [];
    const only = (process.env.ONLY || '').trim();
    let queue = NO_MUTATE ? tests.filter((t) => !/^M\d/.test(t.name)) : tests;
    if (only) {
        queue = queue.filter((t) => t.name.startsWith(only) || t.name.includes(only));
        if (!queue.length) { process.stdout.write(`  FAIL ONLY="${only}" matched 0 of ${queue.length + 1}\n`); process.exit(1); }
        process.stdout.write(`  [filtered] ONLY="${only}" -> ${queue.length} tests\n`);
    }
    const seen = new Map();
    for (const t of queue) seen.set(t.name, (seen.get(t.name) || 0) + 1);
    const dups = [...seen].filter(([, n]) => n > 1).map(([nm]) => nm);
    if (dups.length) { process.stdout.write('  FAIL duplicate test names: ' + dups.join(' | ') + '\n'); process.exit(1); }
    const registered = queue.length;
    for (const t of queue) {
        try { await t.fn(); pass++; process.stdout.write('  ok   ' + t.name + '\n'); }
        catch (e) {
            fails.push({ name: t.name, err: e });
            process.stdout.write('  FAIL ' + t.name + '\n         ' + String(e.message).split('\n').join('\n         ') + '\n');
        }
    }
    if (pass + fails.length !== registered) {
        process.stdout.write(`  FAIL harness: registered ${registered}, ran ${pass + fails.length}\n`);
        fails.push({ name: 'harness', err: new Error('count mismatch') });
    }
    process.stdout.write(`\n${pass} passed / ${fails.length} failed  (of ${registered} registered) in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    process.exit(fails.length ? 1 : 0);
})();
