// lib/compiler/index.js — the P3 deterministic compiler: DNA + ContentSpec +
// UserBrand -> GeneratedSite. ZERO AI CALLS, zero Date, zero Math.random.
//
// The identity firewall is two-layer, and the two layers answer DIFFERENT
// questions. Both fail hard; neither silently sanitizes.
//
//   Tier 1 (data): scan ContentSpec + UserBrand before anything is built.
//     Question: "did reference identity enter through user/model-supplied data?"
//     Zero exemptions — if the user types the reference brand as their own name,
//     v1 refuses and says why.
//   Tier 2 (structure): scan the rendered site MINUS a baseline computed by
//     rendering the SAME compiler with sentinel inputs. A token that our own
//     fixed vocabulary produces (a CSS class, an SVG tag) is not a leak; a token
//     that only appears with real inputs is. This kills the over-strict-guard
//     trap (a reference called "Focus Labs" must not break every site we build
//     because .focus-visible is structural) WITHOUT weakening the data layer.
//     The baseline is derived from the code, not hand-maintained — hand-written
//     allow-lists go stale, which is how this project's last guard missed a bug.
//
// Other contracts enforced here:
//   * ContentSpec is RE-validated; the compiler does not trust its caller.
//   * opts.scan (identity matcher) is a required argument.
//   * output key order fixed; css/js ship both as fields and embedded in html.
'use strict';
const { validateContent } = require('./content-schema.js');
const { compileTokens } = require('./tokens.js');
const { resolveBrand } = require('./brand.js');
const { buildCss, JS } = require('./style.js');
const { Nav, Hero, Sections, Footer } = require('./components.js');
const { esc } = require('./util.js');

const GENERATOR = 'uidconstruct-v1/0.1.0 (p3-compiler)';
const SENTINEL = 'UidSentinelValue';

class ContentInvalidError extends Error {
    constructor(errors) { super('ContentSpec failed validation: ' + errors.join('; ').slice(0, 600)); this.name = 'ContentInvalidError'; this.errors = errors; }
}
class IdentityLeakError extends Error {
    constructor(layer, hits) {
        super(`identity scan failed at ${layer}; refusing to emit. Tokens: ${hits.join(', ')}`);
        this.name = 'IdentityLeakError'; this.layer = layer; this.hits = hits;
    }
}

function sentinelize(v) {
    if (typeof v === 'string') return v.startsWith('#') ? '#s' : (v === 'primary' || v === 'secondary') ? v : SENTINEL;
    if (Array.isArray(v)) return v.map(sentinelize);
    if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v)) o[k] = (k === 'type' || k === 'kind' || k === 'schema') ? v[k] : sentinelize(v[k]);
        return o;
    }
    return v;
}

// Pure assembly — no gates. compileSite wraps this with validation + scanning;
// the baseline render calls it directly (no recursion through the gates).
function assemble(dna, content, brand) {
    const { tokens, css: tokenCss, adjustments } = compileTokens(dna);
    const b = resolveBrand(brand, tokens);
    const ctx = { navCta: content.nav.cta || null };
    const body = [
        `<a class="skip-link" href="#top">Skip to content</a>`,
        Nav(content.nav, b),
        `<main>` + Hero(content.hero) + '\n' + Sections(content.sections, ctx) + `</main>`,
        Footer(content.footer, b),
    ].join('\n');

    const css = tokenCss + '\n' + buildCss(flattenTokens(tokens), dna, {});
    const js = JS;
    const title = b.tagline ? `${b.name} — ${b.tagline}` : b.name;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(content.hero.sub)}">
<meta name="generator" content="${GENERATOR}">
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>`;

    return {
        schema: 'site/1',
        html, css, js,
        assets: b.logoAsset ? [b.logoAsset] : [],
        meta: { title, description: content.hero.sub, adjustments },
        generator: GENERATOR,
    };
}

function compileSite(dna, content, brand, opts) {
    const o = opts || {};
    if (!dna || dna.schema !== 'designdna/1') throw new Error('compiler: requires a designdna/1 document');
    if (typeof o.scan !== 'function') throw new Error('compiler: opts.scan (identity matcher) is required — the firewall is not optional');

    const cv = validateContent(content);
    if (!cv.ok) throw new ContentInvalidError(cv.errors);
    if (dna.identity && (dna.identity.referenceName !== null || dna.identity.referenceDomain !== null)) {
        throw new IdentityLeakError('dna.identity', ['referenceName/referenceDomain not null (structural)']);
    }

    // ---- Tier 1: data firewall, no exemptions ------------------------------
    // DNA deliberately NOT scanned: measured by construction, the compiler
    // consumes only DNA's numbers, enums and hex role values — its prose
    // (principles, idioms.pattern, voice labels) never reaches the render. The
    // test suite pins that claim; if a future renderer starts printing DNA
    // prose, Tier 2 below is what catches it.
    const dataWire = JSON.stringify(content) + '\n' + JSON.stringify(brand || {});
    const t1 = o.scan(dataWire);
    if (t1 && t1.size) throw new IdentityLeakError('content/brand data', [...t1]);

    // ---- build ---------------------------------------------------------------
    const site = assemble(dna, content, brand);

    // ---- Tier 2: structure firewall, minus the code-derived baseline --------
    const sContent = sentinelize(content);
    sContent.brand = { name: SENTINEL };
    const sBrand = { name: SENTINEL, logo: { mode: 'generated' } };
    const baselineSite = assemble(dna, sContent, sBrand);
    const baseline = o.scan([baselineSite.html, baselineSite.js, baselineSite.assets.map((a) => a.dataUrl).join('\n')].join('\n')) || new Set();

    // Decode SVG data URLs before scanning: a reference brand rendered as SVG
    // <text> is invisible to any scan of its base64 form. An encoded payload
    // you do not decode is a payload you have not scanned.
    const decodeAsset = (a) => (a.mime === 'image/svg+xml'
        ? Buffer.from(String(a.dataUrl).split('base64,')[1] || '', 'base64').toString('latin1')
        : a.dataUrl);
    const wire = [site.html, site.js, site.assets.map(decodeAsset).join('\n')].join('\n');
    const t2 = new Set([...(o.scan(wire) || [])].filter((t) => !baseline.has(t)));
    if (t2.size) throw new IdentityLeakError('rendered site', [...t2]);

    site.identityScan = { passed: true, layers: ['data', 'render+decoded-assets-minus-baseline', 'dna.identity-structural'] };
    return site;
}

// tokens.js emits {'color-canvas': ...}; style uses var(--color-canvas);
// bridge by prefixing once, in fixed key order.
function flattenTokens(tokens) {
    const out = {};
    for (const k of Object.keys(tokens)) out['--' + k] = tokens[k];
    return out;
}

module.exports = { compileSite, assemble, ContentInvalidError, IdentityLeakError, GENERATOR, SENTINEL, sentinelize };
