// tests/fixtures/dna-zephyrion.js - SYNTHETIC fixture. No third-party bytes.
//
// The brand is invented ("Zephyrion") and deliberately hostile to naive
// sanitisation: it appears in the URL, the domain, an asset host, every font
// family name, inside type-token VALUES (a font stack), in CSS-module selectors,
// and as a vendor design-system prefix on token names. Vendor-prefixed custom
// properties are the measured norm on real sites, so this is the shape of the
// problem, reproduced with fabricated values.
'use strict';

const EXTRACTED = {
    designTokens: [
        '[color]',
        '  --zns-color-0: #ffffff',
        '  --zns-color-100: #f6f5f2',
        '  --zns-color-900: #141413',
        '  --zns-color-950: #0b0b0a',
        '  --zns-color-accent: #3d5afe',
        '  --zns-color-accent-ink: #ffffff',
        '  --zns-color-muted: #6b6b66',
        '  --zns-color-line: #e3e1dc',
        '  --zns-color-good: #17845a',
        '  --zns-color-warn: #b45309',
        '  --zns-color-bad: #b3261e',
        '[type]',
        '  --zns-font-family-sans: "ZephyrionSans", system-ui',
        '  --zns-font-family-serif: "ZephyrionSerif", Georgia',
        '  --zns-font-weight-regular: 400',
        '  --zns-font-weight-medium: 500',
        '  --zns-text-xs: 12px',
        '  --zns-text-sm: 14px',
        '  --zns-text-base: 16px',
        '  --zns-text-lg: 20px',
        '  --zns-text-xl: 25px',
        '  --zns-text-2xl: 31px',
        '  --zns-text-3xl: 39px',
        '  --zns-leading-tight: 1.1',
        '[geometry]',
        '  --zns-radius-none: 0px',
        '  --zns-radius-xs: 4px',
        '  --zns-radius-sm: 6px',
        '  --zns-radius-md: 12px',
        '  --zns-radius-pill: 9999px',
        '  --zns-gap-xs: 8px',
        '  --zns-gap-sm: 16px',
        '  --zns-gap-md: 24px',
        '  --zns-gap-lg: 32px',
        '  --zns-gap-xl: 64px',
        '  --zns-border-hairline: 1px',
        '  --zns-size-content: 1200px',
    ],
    cssFonts: ['ZephyrionSans', 'ZephyrionSans Fallback', 'ZephyrionSerif', 'ZephyrionMono'],
    // BARE STRINGS, matching the real producer. mineBreakpoints (lib/mine.js:291)
    // does bps.add(m[1] + m[2]) -> "768px", and the saved real extraction
    // (_p0/extraction-blob-f3a543c.json) is ["834px","1200px",...] - all typeof string.
    // facts.js px() anchors ^...px$ against the WHOLE string, so the previous
    // "(min-width: 640px)" form parsed to null, was filtered out, and made layout
    // report status:"unavailable" with breakpointsPx:[] - a fixture that could never
    // produce a correct DNA for a site that does have breakpoints.
    cssBreakpoints: ['640px', '768px', '1024px', '1280px'],
    componentRules: [
        '.Button-module__ab12cd__button { border-radius: var(--zns-radius-pill); background: var(--zns-color-accent); color: var(--zns-color-accent-ink); padding: 10px 18px; font-weight: 500 }',
        '.Card-module__ef34gh__card { border-radius: var(--zns-radius-md); background: var(--zns-color-0); border: 1px solid var(--zns-color-line); padding: 24px }',
        '.Nav-module__ij56kl__nav { display: flex; gap: 16px; height: 64px; background: var(--zns-color-100) }',
        '.Input-module__mn78op__input { border: 1px solid var(--zns-color-line); border-radius: var(--zns-radius-xs); padding: 8px 12px; --zns-internal-token: 3 }',
        '.Heading-module__qr90st__head { font-family: "ZephyrionSerif"; font-size: 39px; line-height: 1.1; letter-spacing: -0.02em }',
    ],
    motion: [
        '@keyframes zephyrionReveal { from { opacity: 0; transform: translateY(8px) } to { opacity: 1 } }',
        '@keyframes floatDot { 50% { transform: translateY(-4px) } }',
        'transition: opacity 200ms ease-out, transform 300ms cubic-bezier(.2,.8,.2,1)',
        '@media (prefers-reduced-motion: reduce) { * { animation: none !important } }',
    ],
    assets: [
        'og:image: https://assets.zephyrion.com/img/og-9f3a1c.png',
        'icon: https://assets.zephyrion.com/fav/zns-44b7.ico',
    ],
    // The reference extraction DOES carry this. facts.js never reads it, and the
    // test suite proves none of it reaches AI #1. Kept here so the quarantine
    // assertion has something real to fail on if the wiring regresses.
    pageOutline: 'Zephyrion Cloud. Ship faster with Zephyrion. Trusted by teams everywhere. Zephyrion pricing.',
};

const META = {
    url: 'https://zephyrion.com/products?ref=launch',
    domain: 'zephyrion.com',
    fetchedAt: 1757000000000,
    httpStatus: 200,
    htmlBytes: 295278,
    cssBytes: 373956,
    droppedCssLinks: 0,
    degraded: false,
    truncated: false,
    notes: [],
    skeleton: {
        sections: 7,
        headings: { h1: 1, h2: 14, h3: 9 },
        nav: 22, buttons: 31, links: 240, cards: 6,
        labels: ['Products', 'Pricing', 'Docs', 'Zephyrion Cloud'],
    },
};

// Decoys: values that are NOT in DesignFacts. Used by the grounding tests.
const DECOY = {
    hex: '#112233',
    radius: '7px',
    scaleRatio: 1.618,
    baseUnit: 5,
    maxWidth: 1440,
    duration: 250,
    breakpoint: 900,
    weight: 700,
};

const HEX = {
    canvas: '#ffffff', text: '#141413', accent: '#3d5afe',
    border: '#e3e1dc', success: '#17845a', danger: '#b3261e',
};

// A DNA that satisfies schema AND grounding, built FROM the projection so it is
// grounded by construction. Tests then mutate exactly one field: every invalid
// variant must come from an edit, never from a fixture bug.
function validDnaFrom(ctx) {
    const obs = ctx.projection.observed;
    const aliasFor = (hex) => {
        const hit = obs.colour.tokens.filter(function (t) { return t.value === hex; });
        return hit.length ? hit[0].alias : null;
    };
    const radiusValues = obs.geometry.tokens
        .filter(function (t) { return t.label === 'radius'; })
        .map(function (t) { return t.value; });
    const bps = obs.layout.breakpointsPx;
    const durs = obs.motion.durationsMs;
    const kinds = obs.components.kinds;
    const roles = Object.keys(HEX).map(function (role) {
        const r = { role: role, value: HEX[role] };
        const a = aliasFor(HEX[role]);
        if (a) r.factRef = a;
        return r;
    });
    return {
        schema: 'designdna/1',
        factsHash: ctx.factsHash,
        model: ctx.projection.model,
        identity: { referenceName: null, referenceDomain: null },
        palette: { roles: roles, temperature: 'neutral', saturation: 'low', contrastStrategy: 'high' },
        typography: { status: 'extracted', hierarchy: 'modular', scaleRatio: 1.25, display: 'serif', body: 'sans', weightsUsed: [400, 500] },
        spacing: { status: 'extracted', baseUnit: 8, rhythm: 'loose' },
        radius: { status: 'extracted', posture: 'pill', values: radiusValues.slice(0, 4) },
        layout: { status: 'extracted', density: 'airy', maxWidth: 1200, breakpointLadder: bps.slice(0, 4) },
        components: { status: 'extracted', idioms: kinds.slice(0, 5).map(function (k) { return { kind: k, pattern: 'solid fill, generous padding, short label' }; }) },
        motion: { status: 'extracted', signature: 'reveal', honoursReducedMotion: true, durationsMs: durs.slice(0, 2) },
        voice: { tone: 'plain', sentenceLength: 'short', structuralLabels: ['products', 'pricing'] },
        principles: [
            'A near-neutral canvas carries almost all the weight, and one saturated accent does the persuading.',
            'Rounded geometry is reserved for interactive elements, so shape itself signals affordance.',
        ],
        gaps: ['imagery not observable from static CSS', 'hover states not present in extracted rules'],
    };
}

module.exports = { EXTRACTED, META, DECOY, HEX, validDnaFrom };
