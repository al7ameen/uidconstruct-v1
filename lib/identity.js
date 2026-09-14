// lib/identity.js — identity-bearing strings: derivation, scanning, redaction.
//
// Design rule (measured, not assumed): the reference identity is NOT confined to
// the url/domain fields. Against real bytes, pageOutline carried the brand name
// 44 times and the vendor 6 times; every one of the six extracted font families
// was named after the vendor; and the two asset URLs pointed at a vendor CDN
// host. A sanitizer that only removes source.url and source.domain would still
// hand the model enough typography to name the site. So identity is treated as a
// property of VALUES anywhere in the payload, not of specific keys.
//
// Everything here is deterministic and exported for tests: an identity guard you
// cannot call directly is an identity guard you cannot prove.

const STOP = new Set([
    // generic words that show up inside vendor names and mean nothing on their
    // own - matching these would redact half the vocabulary
    'com', 'www', 'http', 'https', 'app', 'apps', 'the', 'and', 'for', 'inc',
    'llc', 'ltd', 'co', 'io', 'ai', 'api', 'cdn', 'assets', 'static', 'media',
    'img', 'images', 'image', 'font', 'fonts', 'fallback', 'module', 'scss',
    'css', 'js', 'next', 'nuxt', 'default', 'index', 'main', 'page', 'pages',
]);

// Closed vocabulary of CSS/design terms. Identity-bearing? No. Schema-required?
// Yes - several of these are legal enum values in DesignDNA.
const GENERIC = new Set([
    'sans', 'serif', 'mono', 'slab', 'script', 'display', 'system', 'ui',
    'round', 'condensed', 'extended', 'regular', 'medium', 'bold', 'italic',
    'light', 'semibold', 'variable', 'webfont', 'woff', 'woff2', 'otf', 'ttf',
    'px', 'rem', 'em', 'ms', 'rgb', 'rgba', 'hsl', 'hsla', 'oklch', 'hex',
    'text', 'body', 'heading', 'headings', 'color', 'colors', 'colour',
    'colours', 'size', 'weight', 'radius', 'spacing', 'gap', 'border',
    'background', 'primary', 'secondary', 'tertiary', 'default', 'base',
    'small', 'large', 'xsmall', 'xlarge', 'min', 'max', 'width', 'height',
    'products', 'pricing', 'docs', 'home', 'about', 'launch', 'cloud',
]);

// Split an arbitrary identifier/host/phrase into candidate brand tokens.
function tokens(str) {
    const out = new Set();
    // camelCase/PascalCase are split FIRST. 'ZephyrionSans' yields
    // {zephyrion, sans}, not the single opaque token 'zephyrionssans'-equivalent,
    // which would match nothing a model could plausibly emit.
    const spaced = String(str).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    for (const part of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
        if (part.length < 3) continue;
        if (STOP.has(part)) continue;
        if (/^\d+$/.test(part)) continue;
        out.add(part);
    }
    return out;
}

// Build the forbidden set for one extraction. Deliberately conservative: the
// domain, its registrable label, every host that appeared in assets, and every
// word that appears in an extracted font family name (which is where vendor
// naming leaks most reliably).
function hostOf(str) {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(str || '').trim());
    const raw = m ? m[1] : (/[./]/.test(String(str || '')) ? String(str) : null);
    return raw ? raw.toLowerCase().replace(/^www\./, '') : null;
}

function buildForbidden(designFacts) {
    const forbidden = new Set();
    const src = (designFacts && designFacts.source) || {};
    const add = (s) => { for (const t of tokens(s)) forbidden.add(t); };

    if (src.domain) {
        add(src.domain);
        // "assets.claude.com" -> "claude" must be forbidden even if domain is
        // absent, so we also add each label of the domain itself.
        for (const label of String(src.domain).split('.')) add(label);
    }
    // Host only, NEVER the path or query. Tokenizing a full URL turned ordinary
    // English words in the path ('products', 'launch', 'pricing') into globally
    // forbidden tokens, which over-blocks: it redacts benign data and can make a
    // legitimate analysis fail its own identity gate. Identity lives in the host.
    if (src.url) { const h = hostOf(src.url); if (h) add(h); }
    if (src.hosts) for (const h of src.hosts) add(h);

    const assets = (designFacts.assets && designFacts.assets.items) || [];
    // Same host-only rule: an asset URL's path ('/img/og-launch.png') is not
    // identity evidence, and adding it would forbid ordinary English words.
    for (const a of assets) add((a && a.host) || hostOf(a && a.url) || '');

    const type = designFacts.type || {};
    for (const f of type.families || []) add(f && (f.raw || f.name || ''));

    // Whole-string variants: a substring scan catches "claude", but we also want
    // to catch a bare domain appearing verbatim anywhere.
    const literals = new Set();
    for (const s of [src.domain, hostOf(src.url), ...(src.hosts || [])]) {
        if (s && typeof s === 'string' && s.length > 2) literals.add(String(s).toLowerCase());
    }

    // Generic typography/CSS vocabulary must NEVER be forbidden, even though it
    // arrives inside family names ('ZephyrionSans' -> zephyrion + sans). Without
    // this the projection's own required output (families ['sans','serif','mono'],
    // typography.body:'serif', display:'sans') trips the identity gate, and gate 0
    // refuses EVERY analysis of any site with a serif or sans font. An over-strict
    // guard that always fires is indistinguishable from a broken pipeline - and it
    // fails in the direction that looks like a security win.
    for (const g of GENERIC) forbidden.delete(g);

    return { forbidden: forbidden, literals: [...literals] };
}

function findLeaks(value, matcher) {
    const hits = new Set();
    const walk = (v, path) => {
        if (v === null || v === undefined) return;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            for (const h of matcher(String(v))) hits.add(path + ' = ' + h);
            return;
        }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
        if (typeof v === 'object') {
            for (const k of Object.keys(v)) {
                if (matcher(k).size) hits.add(path + '.' + k + ' (KEY)');
                walk(v[k], path + '.' + k);
            }
        }
    };
    walk(value, '$');
    return [...hits];
}

// The scanner used by every identity gate: token match + literal match,
// case-insensitive, on the serialized form.
function makeScanner(ref) {
    const toks = [...ref.forbidden];
    const lits = ref.literals;
    return function scan(str) {
        const found = new Set();
        const lower = String(str).toLowerCase();
        for (const t of toks) if (lower.includes(t)) found.add(t);
        for (const l of lits) if (lower.includes(l)) found.add(l);
        return found;
    };
}

function redactString(str, forbidden) {
    let out = String(str);
    for (const t of [...forbidden].sort((a, b) => b.length - a.length)) {
        // Left boundary, and a right edge that also accepts a camelCase hump:
        // 'ZephyrionSans' must redact via the token 'zephyrion' even though there is
        // no \b before the capital S.
        out = out.replace(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\b|[A-Z0-9_-])', 'gi'), '[redacted]');
    }
    return out;
}

module.exports = { buildForbidden, findLeaks, makeScanner, redactString, tokens, hostOf, GENERIC };
