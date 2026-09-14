// lib/projection.js — the SANITIZED AI #1 input. Locked rule #3.
//
// DesignFacts is the complete server-side record: url, domain, asset hosts,
// brand-named font families, hashed selectors. It must never be serialized to a
// prompt. This module is the ONLY representation AI #1 is allowed to see, and
// it is built by WHITELIST (emit only enumerated fields), not by blacklist
// (remove known-bad fields). That distinction is the whole point: a blacklist
// silently leaks on every new field anyone ever adds to DesignFacts, and this
// project has already been bitten by exactly that class of bug - all six font
// families on a real site were named after the vendor, and "drop the url and
// domain fields" would have shipped them straight through.
//
// Identity-bearing things removed here, each measured against real bytes:
//   source.url / source.domain        - direct identity
//   assets.items[].url / .host        - vendor CDN URLs
//   type.families[].raw               - "anthropicSans" etc: identity via typography
//   components.items[].selector/.css  - CSS-module hashes + vendor strings
//   motion.items[].name               - "NavMobile-module-...__panelOpen"
//   structure                         - page copy is never in facts at all; only
//                                       element counts survive here
// Everything that survives is either numeric, a hex value (not copyrightable,
// not identifying on its own), or a closed-vocabulary enum we chose.

const { buildForbidden, findLeaks, makeScanner, redactString } = require('./identity.js');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Derive a font CATEGORY from a family name without echoing the name.
// Heuristic + measured on the real site: families were Sans / Serif / Mono +
// Fallback variants. Fallback entries are dropped, not summarised.
function categoryOfFamily(name) {
    const n = String(name).toLowerCase();
    if (/fallback|system-ui|sans-serif$|-ui\b/.test(n) && !/(mono|serif|slab|display)/.test(n)) return 'fallback';
    if (/mono|code|consol|courier|menlo|jetbrains|roboto-mono|sf-mono|source-code|ibm-plex-m/.test(n)) return 'mono';
    if (/serif|georgia|times|playfair|merriweather|garamond|reclaim|clash|tiempos|frank|lyon/.test(n)) return 'serif';
    if (/slab|rockwell|zilla/.test(n)) return 'slab';
    if (/sans|helvet|inter|roboto|arial|grotesk|neo|soehne|suisse/.test(n)) return 'sans';
    if (/disp|head|banner/.test(n)) return 'display';
    return 'unknown';
}

// Numbers are allowed to be dropped for identity reasons; they must never be
// invented to fill a gap. Absence is represented by the section status.
// A token's NAME is useful (it says whether 500 is a font-weight or a border-radius)
// and dangerous (real measured names include --hds-color-util-neutral-200,
// --r-globalnav-color, --tatami-color-gray-*: vendor design-system prefixes are the
// norm, not an edge case). So we never echo a name fragment. We match it against a
// closed vocabulary of generic CSS concepts and emit the matched label, or 'other'.
// This is identity-PROOF rather than identity-list-dependent: a brand we failed to
// put on the forbidden list still cannot escape, because nothing from the name ships.
const LABEL_WORDS = [
    ['weight', /(^|[^a-z])w(eigh|oight|t)|font-weight|bold|semibold|medium|light|black/],
    ['size',   /size|fs-|font-size|text-|heading|h[1-6]\b|display|body/],
    ['line-height', /line[-_]?height|lh\b|leading/],
    ['letter-spacing', /letter|tracking|ls\b/],
    ['family', /family|font-\b|typeface/],
    ['radius', /radius|round|rd-|corner/],
    ['spacing', /gap|space|padding|margin|pad|mt-|mb-|mx-|my-|px-|py-|indent/],
    ['border', /border|stroke|hairline|rule/],
    ['shadow', /shadow|elevation|drop/],
    ['blur',   /blur|backdrop/],
    ['color',  /color|colour|fg|bg|background|text|icon|border|accent|surface|palette|gray|grey|neutral|brand|success|warning|danger|error/],
    ['width',  /width|max-w|min-w|container|breakpoint|screen/],
    ['duration', /duration|dur\b|speed|time/],
    ['ease',   /ease|cubic|timing/],
];
function labelOf(name) {
    const n = String(name || '').toLowerCase();
    for (const [label, re] of LABEL_WORDS) if (re.test(n)) return label;
    return 'other';
}

function buildProjection(designFacts) {
    const f = designFacts || {};
    const forbidden = buildForbidden(f);
    const ref = { forbidden: forbidden.forbidden, literals: forbidden.literals, list: [...forbidden.forbidden], scan: makeScanner(forbidden) };

    // ---- colour: hex values only (role assignment is the model's job) ------
    const colourItems = (f.colour && f.colour.items) || [];
    const allowedHex = new Set();
    const allowedColourTokens = new Map(); // name -> hex
    const colours = [];
    for (const it of colourItems) {
        const v = it.value || it.rawValue;
        if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim())) {
            const norm = v.trim().toLowerCase();
            allowedHex.add(norm);
            const alias = 'c' + (colours.length + 1);
            allowedColourTokens.set(alias, norm);      // factRef is the ALIAS
            colours.push({ alias, label: labelOf(it.name), value: norm });
        }
    }

    // ---- type: numeric tokens + family CATEGORIES (never names) ------------
    // Label-only NAMES are not sufficient. A family token's VALUE is a font stack -
    // the measured real value was '"anthropicSans", system-ui' - so the vendor name
    // crosses the boundary through the value even when the name is sanitised. Every
    // token value therefore passes through redactString: numbers survive (grounding
    // needs them), identifiers do not.
    const redactVal = (v) => redactString(String(v), ref.forbidden);
    const typeTokens = ((f.type && f.type.tokens) || []).map((t, i) => ({ alias: 't' + (i + 1), label: labelOf(t.name), value: redactVal(t.rawValue) }));
    const fams = ((f.type && f.type.families) || []).map((x) => x.raw);
    const cats = [...new Set(fams.map(categoryOfFamily))].filter((c) => c !== 'fallback');

    // ---- geometry -----------------------------------------------------------
    const geom = ((f.geometry && f.geometry.items) || []).map((g, i) => ({ alias: 'g' + (i + 1), label: labelOf(g.name), value: redactVal(g.rawValue) }));
    // Exact string set for radius.values grounding, plus normalized forms so
    // "0.5px" and ".5px" are the same fact to the validator.
    const allowedGeomValues = new Set();
    for (const g of geom) {
        const raw = String(g.value).trim().toLowerCase();
        if (!raw) continue;
        allowedGeomValues.add(raw);
        const n = num(raw);
        if (n !== null) {
            allowedGeomValues.add(String(n));
            const unit = /(%|rem|em|px|pt)$/.exec(raw);
            if (unit) { allowedGeomValues.add(n + unit[1]); allowedGeomValues.add(String(n) + unit[1]); }
        }
    }

    // ---- breakpoints --------------------------------------------------------
    const bps = ((f.layout && f.layout.breakpoints) || []).map((b) => b.px).filter((n) => n !== null);

    // ---- components: KINDS only, plus a whitelist of CSS property names -----
    const compItems = ((f.components && f.components.items) || []);
    const compKinds = [...new Set(compItems.map((c) => c.kind || 'unknown'))];
    const cssProps = new Set();
    for (const c of compItems) {
        const body = /{([\s\S]*)}/.exec(String(c.css || ''));
        if (!body) continue;
        for (const decl of body[1].split(';')) {
            const m = /^\s*([a-z-]+)\s*:/.exec(decl);
            // '--anything' is a CUSTOM PROPERTY, i.e. a name chosen by the vendor,
            // and measured names carry design-system prefixes. Only standard
            // property names (generic CSS vocabulary) may cross the boundary.
            if (m && !m[1].startsWith('--')) cssProps.add(m[1]);
        }
    }

    // ---- motion: structural only. names removed, reduced-motion flag kept --
    const mot = ((f.motion && f.motion.items) || []);
    const motionKinds = { keyframes: mot.filter((m) => m.kind === 'keyframes').length, media: mot.filter((m) => m.kind === 'media').length, other: mot.filter((m) => m.kind === 'other').length };
    const msValues = new Set();
    for (const m of mot) {
        for (const x of String(m.raw).matchAll(/(\d+(?:\.\d+)?)ms/g)) {
            const n = num(x[1]); if (n !== null) msValues.add(n);
        }
    }

    // ---- structure: counts survive, text never ------------------------------
    const skel = (f.structure && f.structure.skeleton) || null;

    const projection = {
        schema: 'dnainput/1',
        factsHash: null, // filled by caller from the hash util
        observed: {
            colour: {
                status: (f.colour && f.colour.status) || 'unavailable',
                uniqueHex: [...allowedHex],
                tokens: colours.slice(0, 24),
            },
            type: {
                status: (f.type && f.type.status) || 'unavailable',
                families: cats.length ? cats : null,
                tokens: typeTokens.slice(0, 14),
            },
            geometry: {
                status: (f.geometry && f.geometry.status) || 'unavailable',
                tokens: geom.slice(0, 24),
            },
            layout: {
                status: (f.layout && f.layout.status) || 'unavailable',
                breakpointsPx: [...new Set(bps)].sort((a, b) => a - b).slice(0, 12),
            },
            components: {
                status: (f.components && f.components.status) || 'unavailable',
                kinds: compKinds,
                propertiesUsed: [...cssProps].sort().slice(0, 40),
            },
            motion: {
                status: (f.motion && f.motion.status) || 'unavailable',
                counts: motionKinds,
                durationsMs: [...msValues].sort((a, b) => a - b).slice(0, 10),
                reducedMotionPresent: !!(f.motion && f.motion.reducedMotionPresent),
            },
            structure: skel
                ? { status: 'extracted', skeleton: redactSkeleton(skel, forbidden.forbidden) }
                : { status: 'unavailable' },
        },
    };

    const grounding = { allowedHex, allowedColourTokens, allowedGeomValues, numbers: collectNumbers(projection) };
    return { projection, forbidden: ref, grounding };
}

function redactSkeleton(skel, forbidden) {
    // skeleton is counts/labels; labels ("Products") can be brand-adjacent, so
    // keys are scanned too and any string value is redacted defensively.
    const out = {};
    for (const [k, v] of Object.entries(skel)) {
        if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
        if (Array.isArray(v)) { out[k] = v.map((x) => redactString(x, forbidden)); continue; }
        if (v && typeof v === 'object') { out[k] = redactSkeleton(v, forbidden); continue; }
        if (typeof v === 'string') out[k] = redactString(v, forbidden);
    }
    return out;
}

// Every number that may legally appear in DesignDNA as a factual value.
// ENUMERATED SOURCES ON PURPOSE. The first version walked the whole projection,
// which admitted page-structure counts: measured, observed.structure.skeleton
// .sections = 7 put 7 into the allow-list, so an invented radius.values ["7px"]
// and an invented spacing.baseUnit 5 both passed grounding. That made rule #1
// ("no invented numbers") decorative for exactly the fields it exists to protect.
// Element counts, keyframe counts and link counts are true facts about the page
// but they are NOT design values, and no DNA field is allowed to assert one.
const DESIGN_NUMBER_SOURCES = [
    (o) => (o.geometry && o.geometry.tokens || []).map((t) => t.value),
    (o) => (o.type && o.type.tokens || []).map((t) => t.value),
    (o) => (o.layout && o.layout.breakpointsPx) || [],
    (o) => (o.motion && o.motion.durationsMs) || [],
];

function collectNumbers(projection) {
    const set = new Set();
    const obs = (projection && projection.observed) || {};
    for (const grab of DESIGN_NUMBER_SOURCES) {
        for (const v of grab(obs) || []) {
            if (typeof v === 'number' && Number.isFinite(v)) { set.add(v); continue; }
            if (typeof v !== 'string') continue;
            for (const m of v.matchAll(/-?\d+(?:\.\d+)?/g)) { const n = num(m[0]); if (n !== null) set.add(n); }
        }
    }
    return set;
}

// Serialize for the prompt. Deterministic: the projection is plain JSON and we
// stringify it with sorted keys via canonicalJson upstream.
function leaksInProjection(projection, ref) {
    const s = JSON.stringify(projection);
    return findLeaks(s, ref.scan).slice(0, 20);
}

module.exports = { buildProjection, categoryOfFamily, collectNumbers, leaksInProjection, redactSkeleton };
