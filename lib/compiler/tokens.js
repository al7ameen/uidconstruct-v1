// lib/compiler/tokens.js — DesignDNA -> a flat CSS custom-property token set.
//
// This is the ONLY place DNA numbers become CSS. Determinism rule: the output is
// a function of (dna) alone, emitted in a FIXED key order (objects built in
// literal order, then serialized by name list) so JSON.stringify is stable and
// the byte-equality invariant holds.
//
// Contrast policy, learned the hard way on this project (inverted-card bug:
// 1.05:1 white-alpha shipped as "muted text"): we do NOT ship DNA colours blindly
// as TEXT roles. A text role whose contrast against its background is below
// threshold is nudged along the line toward the background's opposite pole by
// mixing with the canvas/text anchor. The nudge is deterministic (fixed thresholds,
// fixed mix steps) and reported in `adjustments` — never silent.
'use strict';
const { clamp, round, mix, contrast, readableOn, isHex } = require('./util.js');

const AA_TEXT = 4.5;      // WCAG AA, normal text
const AA_LARGE = 3.0;     // AA, large/display text
const MIN_TEXT = 2.0;     // absolute floor: below this, keep nudging

// nudge `fg` toward `toward` until it clears `target` against `bg`, or steps run out
function fixContrast(fg, bg, target, toward) {
    if (!isHex(fg) || !isHex(bg)) return { value: fg, adjusted: false };
    if (contrast(fg, bg) >= target) return { value: fg, adjusted: false };
    for (let t = 0.1; t <= 1.0001; t = round(t + 0.1, 2)) {
        const cand = mix(fg, toward, t);
        if (contrast(cand, bg) >= target) return { value: cand, adjusted: t >= 1 ? true : true };
    }
    return { value: toward, adjusted: true };
}

function roleMap(dna) {
    const m = {};
    const roles = (dna.palette && dna.palette.roles) || [];
    for (const r of roles) if (r && isHex(r.value)) m[r.role] = r.value.toLowerCase();
    return m;
}

// Typography scale from hierarchy + scaleRatio. When ratio is unknown we still
// need a working site, so we fall back to a conventional 1.2 — and say so.
function typeScale(dna) {
    const ty = dna.typography || {};
    const ratio = (typeof ty.scaleRatio === 'number' && ty.scaleRatio >= 1 && ty.scaleRatio <= 3)
        ? round(ty.scaleRatio, 3) : 1.2;
    const base = 16; // user-agent em anchor; DNA carries ratios, not rem bases
    const s = { base: base };
    // 'stepped' skips a level (coarser ladder); 'modular'/'fluid' walk it.
    // Powers, never ratio*step: the first cut multiplied where it should
    // exponentiate, and a test asserting monotonicity (below) caught it.
    const step = (ty.hierarchy === 'stepped') ? 2 : 1;
    s.sm = round(base / Math.pow(ratio, step), 2);
    s.lg = round(base * Math.pow(ratio, step), 2);
    s.xl = round(base * Math.pow(ratio, 2 * step), 2);
    s['2xl'] = round(base * Math.pow(ratio, 3 * step), 2);
    s['3xl'] = round(base * Math.pow(ratio, 4 * step), 2);
    s.ratio = ratio;
    return s;
}

// Spacing ladder from baseUnit; rhythm adjusts section padding, not the ladder.
function spaceLadder(dna) {
    const sp = dna.spacing || {};
    const base = (typeof sp.baseUnit === 'number' && sp.baseUnit >= 1 && sp.baseUnit <= 64) ? sp.baseUnit : 8;
    return { unit: base, xs: base / 4, sm: base / 2, md: base, lg: base * 2, xl: base * 4, '2xl': base * 8 };
}

// Radius ladder from the extracted values (post-projection these are generic
// labels, already fact-grounded numbers as strings like "8px").
function radiusLadder(dna) {
    const rd = dna.radius || {};
    const nums = (rd.values || []).map((v) => parseFloat(v)).filter((n) => Number.isFinite(n) && n >= 0);
    const uniq = [...new Set(nums)].sort((a, b) => a - b);
    const pick = (i, fb) => (uniq.length ? uniq[clamp(i, 0, uniq.length - 1)] : fb);
    const posture = rd.posture || 'unknown';
    if (posture === 'pill' && uniq.length === 0) return { sm: 8, md: 14, lg: 999 };
    if (posture === 'sharp') return { sm: 0, md: 0, lg: 0 };
    return { sm: round(pick(0, 4), 2), md: round(pick(Math.floor((uniq.length - 1) / 2), 10), 2), lg: round(pick(uniq.length - 1, 24), 2) };
}

// Shadows: derived from canvas luminance so a dark theme gets darker shadows,
// never a grey smear on near-black.
function shadows(dna, canvas) {
    const dark = canvas ? (require('./util.js').relLuminance(canvas) < 0.2) : false;
    const a = dark ? '0.6' : '0.08';
    const b = dark ? '0.8' : '0.12';
    return { sm: `0 1px 2px rgba(0,0,0,${a})`, md: `0 4px 12px rgba(0,0,0,${a})`, lg: `0 12px 32px rgba(0,0,0,${b})` };
}

// Font stacks: generic families ONLY. Reference family names were stripped by
// projection and must never reappear; `display`/`body` are enums like 'serif'.
function stacks(dna) {
    const ty = dna.typography || {};
    const serif = "Georgia, 'Times New Roman', serif";
    const sans = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
    const mono = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
    const map = { serif, sans, mono, slab: serif, script: serif, unknown: sans };
    return {
        display: map[ty.display] || sans,
        body: map[ty.body] || sans,
        mono: mono,
    };
}

/**
 * Compile DesignDNA into a token object + the :root CSS block.
 * @returns {{tokens:object, css:string, adjustments:Array}}
 */
function compileTokens(dna) {
    const roles = roleMap(dna);
    const adjustments = [];
    const canvas = roles.canvas || (contrast(roles.text || '#000', '#ffffff') > contrast(roles.text || '#000', '#000000') ? '#ffffff' : '#0a0a0a');
    const ink = roles.text || readableOn(canvas);
    const dark = require('./util.js').relLuminance(canvas) < 0.2;

    // Nudge text roles against their real background.
    const text = fixContrast(ink, canvas, AA_TEXT, dark ? '#ffffff' : '#000000');
    if (text.adjusted) adjustments.push({ role: 'text', from: ink, to: text.value, reason: `contrast < ${AA_TEXT} on canvas` });
    const mutedSrc = roles['text-muted'] || mix(ink, canvas, 0.45);
    const muted = fixContrast(mutedSrc, canvas, AA_TEXT, dark ? '#ffffff' : '#000000');
    if (muted.adjusted) adjustments.push({ role: 'text-muted', from: mutedSrc, to: muted.value, reason: `contrast < ${AA_TEXT} on canvas` });

    // Accent as a FILL keeps its hue (brand truth); accent-as-TEXT must be legible.
    const accentFill = roles.accent || '#3d5afe';
    const accentText = fixContrast(roles['accent-text'] || accentFill, canvas, AA_LARGE, dark ? '#ffffff' : '#000000');
    if (accentText.adjusted) adjustments.push({ role: 'accent-text', from: roles['accent-text'] || accentFill, to: accentText.value, reason: `contrast < ${AA_LARGE} on canvas` });
    const accentInk = readableOn(accentFill);

    const surface = roles.surface || mix(canvas, dark ? '#ffffff' : '#000000', 0.04);
    const surfaceAlt = roles['surface-alt'] || mix(canvas, dark ? '#ffffff' : '#000000', 0.08);
    const border = roles.border || mix(canvas, dark ? '#ffffff' : '#000000', 0.16);
    const cardText = readableOn(surface) === '#ffffff' ? (dark ? text.value : text.value) : text.value;

    const ts = typeScale(dna);
    const sl = spaceLadder(dna);
    const rl = radiusLadder(dna);
    const sh = shadows(dna, canvas);
    const st = stacks(dna);
    const mot = dna.motion || {};
    const dur = (Array.isArray(mot.durationsMs) && mot.durationsMs.length) ? mot.durationsMs[0] : 180;

    // FIXED emission order — the determinism contract. Adding a token means
    // adding it here, once, in place.
    const tokens = {
        'color-canvas': canvas, 'color-surface': surface, 'color-surface-alt': surfaceAlt,
        'color-text': text.value, 'color-text-muted': muted.value,
        'color-accent': accentFill, 'color-accent-text': accentText.value, 'color-accent-ink': accentInk,
        'color-border': border,
        'color-success': roles.success || '#17845a', 'color-warning': roles.warning || '#b45309', 'color-danger': roles.danger || '#b3261e',
        'font-display': st.display, 'font-body': st.body, 'font-mono': st.mono,
        'text-sm': ts.sm + 'px', 'text-base': ts.base + 'px', 'text-lg': ts.lg + 'px', 'text-xl': ts.xl + 'px', 'text-2xl': ts['2xl'] + 'px', 'text-3xl': ts['3xl'] + 'px',
        'space-xs': sl.xs + 'px', 'space-sm': sl.sm + 'px', 'space-md': sl.md + 'px', 'space-lg': sl.lg + 'px', 'space-xl': sl.xl + 'px', 'space-2xl': sl['2xl'] + 'px',
        'radius-sm': rl.sm + 'px', 'radius-md': rl.md + 'px', 'radius-lg': rl.lg + 'px',
        'shadow-sm': sh.sm, 'shadow-md': sh.md, 'shadow-lg': sh.lg,
        'motion-dur': dur + 'ms',
        'layout-max': ((dna.layout && dna.layout.maxWidth) || 1120) + 'px',
    };

    const lines = Object.keys(tokens).map((k) => `  --${k}: ${tokens[k]};`);
    const css = ':root {\n' + lines.join('\n') + '\n}';
    return { tokens, css, adjustments };
}

module.exports = { compileTokens, fixContrast, typeScale, spaceLadder, radiusLadder, stacks, AA_TEXT, AA_LARGE };
