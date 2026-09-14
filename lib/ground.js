// lib/ground.js — locked rule #1: no invented factual numbers.
//
// Schema validation answers "is this well-formed?". Grounding answers "is this
// TRUE of the site we looked at?". A JSON-shaped answer can pass the first and
// fail the second, and only the second one is visible to the user: a DNA with a
// plausible-but-invented 1200px maxWidth produces a site that quietly diverges
// from the reference, which is the failure this project keeps hitting (a
// confident spec built on zeros).
//
// A grounded field is legal if its value is EITHER present in the sanitized
// projection, OR deterministically derivable from values that are. Derivations
// are enumerated below and nothing else - "the model computed something" is not
// a derivation we can check, so we recompute it ourselves and compare.

const { normHex } = require('./facts.js');

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; }

// Deterministic derivations from the projection's own numbers.
function deriveNumbers(observed) {
    const derived = new Set();
    const geom = (observed.geometry && observed.geometry.tokens || []).map((t) => px(t.value)).filter((n) => n !== null && n > 0);
    // Labels, not names: projection emits { alias, label, value } precisely so no
    // vendor token name crosses the boundary. A filter on a field that no longer
    // exists would silently return nothing and un-ground every derived number, so
    // tests/dna.test.js asserts this set is NON-EMPTY on the fixture.
    const spacing = (observed.geometry && observed.geometry.tokens || [])
        .filter((t) => t.label === 'spacing')
        .map((t) => px(t.value)).filter((n) => n !== null && n > 0);

    // baseUnit = GCD of the spacing scale. This is the single most common thing
    // a model gets away with inventing, and it is exactly computable.
    if (spacing.length) {
        const g = spacing.reduce((acc, n) => gcd(acc, n), spacing[0]);
        if (g > 0) derived.add(g);
        // and the spacing values themselves
        spacing.forEach((n) => derived.add(n));
    }
    geom.forEach((n) => derived.add(n));

    // scaleRatio: consecutive ratios of sorted type sizes (modular-scale claim).
    const sizes = (observed.type && observed.type.tokens || [])
        .filter((t) => t.label === 'size')
        .map((t) => px(t.value)).filter((n) => n !== null && n > 0);
    const uniq = [...new Set(sizes)].sort((a, b) => a - b);
    for (let i = 1; i < uniq.length; i++) derived.add(round2(uniq[i] / uniq[i - 1]));
    for (let i = 2; i < uniq.length; i++) derived.add(round2(uniq[i] / uniq[i - 2]));

    // breakpoint ladder values are already facts; the differences are derived.
    const bps = (observed.layout && observed.layout.breakpointsPx) || [];
    bps.forEach((n) => derived.add(n));
    for (let i = 1; i < bps.length; i++) derived.add(bps[i] - bps[i - 1]);

    (observed.motion && observed.motion.durationsMs || []).forEach((n) => derived.add(n));
    uniq.forEach((n) => derived.add(n));

    return derived;
}

function round2(n) { return Math.round(n * 100) / 100; }
// Local numericizer: ground.js must not depend on projection.js's helpers, and an
// undefined name here would raise ReferenceError at throw time.
function num(v) {
    const m = /^(-?\d+(?:\.\d+)?)(px|rem|em|%)?$/.exec(String(v).trim().toLowerCase());
    return m ? Number(m[1]) : null;
}
function px(v) { const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v).trim()); return m ? Number(m[1]) : null; }

function within(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---------------------------------------------------------------------------
// validateDna(dna, ctx) -> { ok, errors }
//   errors: { path, kind: 'schema'|'grounding'|'identity', message }
// ---------------------------------------------------------------------------
const { validate, DNA_SCHEMA } = require('./schema.js');
const { findLeaks } = require('./identity.js');

const NUMERIC_RULES = [
    ['typography.scaleRatio', (d) => (d.typography.scaleRatio === null ? undefined : d.typography.scaleRatio), 0.011],
    ['typography.weightsUsed', (d) => d.typography.weightsUsed || [], 0],
    ['spacing.baseUnit', (d) => (d.spacing.baseUnit === null ? undefined : d.spacing.baseUnit), 0.01],
    ['layout.maxWidth', (d) => (d.layout.maxWidth === null ? undefined : d.layout.maxWidth), 0.01],
    ['layout.breakpointLadder', (d) => d.layout.breakpointLadder || [], 0],
    ['motion.durationsMs', (d) => d.motion.durationsMs || [], 0],
];

// radius.values are STRINGS ("7px", "9999px", "0.5px"), so the numeric rules above
// cannot see them. Without this, a model inventing ["7px","13px"] passes every other
// guard and rule #1 is decorative for geometry.
function assertGroundedStrings(dna, ctx, errs) {
    const r = dna.radius;
    if (!r || r.status !== 'extracted') return;
    const allowed = ctx.grounding.allowedGeomValues;
    const derived = deriveNumbers(ctx.projection.observed);
    (r.values || []).forEach((v, i) => {
        const s = String(v).trim().toLowerCase();
        if (allowed.has(s)) return;
        const n = num(v);
        if (n !== null && (ctx.grounding.numbers.has(n) || derived.has(n))) return;
        errs.push({ path: `$.radius.values[${i}]`, kind: 'grounding',
            message: `$.radius.values[${i}] = ${v} is neither an extracted geometry value nor derivable from DesignFacts. Allowed: ${[...allowed].slice(0, 6).join(', ')}. Omit it or set radius.status=unavailable.` });
    });
}

function validateDna(dna, ctx) {
    const errs = [];
    const raw = [];
    validate(dna, DNA_SCHEMA, '$', raw, ctx);
    for (const m of raw) errs.push({ path: m.split(':')[0], kind: 'schema', message: m });

    // Grounding walks assume STRUCTURE. A malformed model answer ({"schema":
    // "designdna/1","nope":true}) has no .typography, so d.typography.scaleRatio
    // below raised TypeError - and dna.js correctly refuses to repair anything
    // that is not a DnaValidationError. The whole repair path was therefore
    // UNREACHABLE and every bad answer became a hard failure (found by executing
    // E1-E3; on the endpoint the production shape of this was a 500).
    // Guarded NARROWLY, not "any schema error -> bail": the identity and meta
    // scans must still run on a document that is structurally sound but
    // semantically wrong, or a leaked brand name escapes the moment any other
    // field is also invalid. B12/C11 assert exactly that ordering property.
    const SECTIONS = ['palette', 'typography', 'spacing', 'radius', 'layout', 'components', 'motion', 'voice'];
    const structurallySound = SECTIONS.every(function (k) { return dna[k] && typeof dna[k] === "object"; });


    if (structurallySound) {
    const observed = ctx.projection.observed;
    const allowedHex = ctx.grounding.allowedHex;
    const numbers = ctx.grounding.numbers;
    const derived = deriveNumbers(observed);

    // ---- palette: every value must be an extracted hex ----------------------
    const roles = (dna.palette && dna.palette.roles) || [];
    const seenRole = new Set();
    roles.forEach((r, i) => {
        const path = `$.palette.roles[${i}]`;
        if (seenRole.has(r.role)) errs.push({ path, kind: 'schema', message: path + ': duplicate role ' + r.role });
        seenRole.add(r.role);
        const h = normHex(r.value);
        if (!h) errs.push({ path, kind: 'grounding', message: path + '.value is not a valid hex' });
        else if (!allowedHex.has(h.toLowerCase())) {
            errs.push({ path: path + '.value', kind: 'grounding', message: `${path}.value ${r.value} does not appear in DesignFacts. Omit this role or mark the section unavailable - do not invent values.` });
        } else if (r.factRef && !ctx.grounding.allowedColourTokens.has(r.factRef)) {
            errs.push({ path: path + '.factRef', kind: 'grounding', message: `${path}.factRef "${r.factRef}" is not a colour token in DesignFacts` });
        }
    });
    // Required roles: a palette that cannot name canvas+text+accent is not usable.
    for (const need of ['canvas', 'text', 'accent']) {
        if (!seenRole.has(need)) errs.push({ path: '$.palette.roles', kind: 'schema', message: `missing required role "${need}" (use facts values only; if none qualify, report it in gaps)` });
    }

    // ---- sections: an 'unavailable' section must not carry invented numbers -
    const assertSectionHonest = (name, getter, label) => {
        const sec = dna[name];
        if (!sec || sec.status !== 'extracted') {
            const v = getter(dna);
            const present = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== 'unknown';
            if (present) errs.push({ path: '$.' + name, kind: 'grounding', message: `$.${name}.status is "unavailable" but ${label} is populated - unavailable sections must be empty/null` });
        }
    };
    assertSectionHonest('typography', (d) => d.typography.scaleRatio, 'scaleRatio');
    assertSectionHonest('spacing', (d) => d.spacing.baseUnit, 'baseUnit');
    assertSectionHonest('layout', (d) => d.layout.maxWidth, 'maxWidth');
    assertSectionHonest('motion', (d) => d.motion.durationsMs, 'durationsMs');

    // ---- numeric grounding --------------------------------------------------
    for (const [path, get, tol] of NUMERIC_RULES) {
        const key = path.split('.')[1];
        const sec = dna[path.split('.')[0]];
        if (!sec || sec.status !== 'extracted') continue;
        const val = get(dna);
        if (val === undefined) continue;
        const list = Array.isArray(val) ? val : [val];
        for (const n of list) {
            if (typeof n !== 'number' || !Number.isFinite(n)) continue;
            const ok = numbers.has(n) || derived.has(n) ||
                (tol > 0 && [...numbers, ...derived].some((x) => within(n, x, tol))) ||
                [...numbers, ...derived].some((x) => within(round2(n), round2(x), 0.011));
            if (!ok) errs.push({ path: '$.' + path, kind: 'grounding', message: `$.${path} = ${n} is neither present in DesignFacts nor derivable from it. Allowed nearby: ${nearest(n, numbers, derived).join(', ') || 'none'}. Omit or mark unavailable.` });
        }
    }

    // ---- component kinds must be kinds we actually saw ---------------------
    const seenKinds = new Set(observed.components.kinds || []);
    ((dna.components && dna.components.idioms) || []).forEach((id, i) => {
        if (!seenKinds.has(id.kind)) errs.push({ path: `$.components.idioms[${i}].kind`, kind: 'grounding', message: `kind "${id.kind}" was not observed in DesignFacts (observed: ${[...seenKinds].join(', ')})` });
    });

    assertGroundedStrings(dna, ctx, errs);
    }

    // ---- identity -----------------------------------------------------------
    const leaks = findLeaks(JSON.stringify(dna), ctx.forbidden.scan);
    for (const l of leaks) errs.push({ path: l.split(' =')[0], kind: 'identity', message: 'DesignDNA contains reference identity: ' + l });

    // ---- meta: model/provider are configuration, not model output ----------
    if (dna.factsHash !== ctx.factsHash) errs.push({ path: '$.factsHash', kind: 'schema', message: `factsHash "${String(dna.factsHash).slice(0, 18)}…" does not match the facts it claims (${ctx.factsHash.slice(0, 18)}…)` });
    if (dna.identity && (dna.identity.referenceName !== null || dna.identity.referenceDomain !== null)) errs.push({ path: '$.identity', kind: 'identity', message: 'identity.referenceName/referenceDomain must be null' });

    return { ok: errs.length === 0, errors: errs };
}

function nearest(n, a, b) {
    return [...a, ...b].filter((x) => typeof x === 'number').sort((x, y) => Math.abs(x - n) - Math.abs(y - n)).slice(0, 3);
}

module.exports = { validateDna, deriveNumbers, gcd, round2 };
