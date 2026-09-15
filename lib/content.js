// lib/content.js — AI call #2. DesignDNA + UserBrand -> ONE request -> validated ContentSpec.
//
// Budget rule (product constraint): a full generation costs exactly two AI calls, one
// here and one in lib/dna.js. The counter is a RETURNED, ASSERTED NUMBER, so "exactly
// one call" is an observation rather than a claim: aiCalls is incremented immediately
// before each request, so a retry that fires in the background is visible in the result
// and catchable in a test. callAIWithFallback is deliberately NOT used — it iterates a
// model chain on provider errors, which would make the count false whenever the provider
// hiccupped. One model, one attempt, honest failure.
//
// Repair: dna.js defaults to one repair retry, which is right for standalone analysis
// but spends the generation budget. Here the default is ZERO retries (CONTENT_REPAIR_RETRIES)
// because P4 sits on the generation path; an invalid answer fails honestly. Opt-in via
// opts.repair >= 1 for the same reason dna.js has it.
//
// Cache: keyed on the SERIALIZED PROMPT (plus model), not on factsHash. The prompt is
// deterministic in (interpretive DNA slice, user brand), so the prompt IS the complete
// identity of the request — including the user's own words, which factsHash deliberately
// ignores because they are not part of the reference. Same prompt bytes => same answer
// wanted => one entry. Different brand name on identical DNA is a different entry, which
// is exactly the property a URL-keyed cache historically got wrong in this project.
'use strict';
const { canonicalJson, sha256 } = require('./canonical.js');
const { buildMessages, dnaToText } = require('./content-prompt.js');
const { validateContent } = require('./compiler/content-schema.js');
const { parseModelJson, DnaValidationError } = require('./dna.js');
const { validateUserBrand, requireDescription } = require('./userbrand.js');
const { buildForbidden, makeScanner } = require('./identity.js');

const CONTENT_SCHEMA_VERSION = 'contentspec/1';
// Read at CALL time, never snapshotted at load: a constant captured on require is the
// silently-dead-test-seam class — a test that sets the env afterwards would be varying
// something nothing reads.
const repairRetries = () => Number(process.env.CONTENT_REPAIR_RETRIES ?? 0);
let CONTENT_TTL_MS = Number(process.env.CONTENT_CACHE_TTL_MS || 7 * 24 * 3600e3);
const CONTENT_MAX_ENTRIES = Number(process.env.CONTENT_CACHE_MAX_ENTRIES || 100);

class ContentBrandError extends Error {
    constructor(message, errors) { super(message); this.name = 'ContentBrandError'; this.errors = errors || []; }
}
class ContentSpecError extends Error {
    constructor(message, errors) { super(message); this.name = 'ContentSpecError'; this.errors = errors || []; }
}
class ContentIdentityError extends Error {
    constructor(message, leaks) { super(message); this.name = 'ContentIdentityError'; this.leaks = leaks || []; }
}

// ---------------------------------------------------------------------------
// Originality floor. Deliberately a HARD rejection rather than a warning: a
// placeholder that reaches a rendered page is a visible defect on the customer's
// site, and "warning" fields nobody reads are how broken CSS used to ship as fact.
// List kept small and unambiguous on purpose — the over-strict guard that always
// fires is indistinguishable from a broken pipeline, which this project has now
// been bitten by twice.
// ---------------------------------------------------------------------------
const FILLER = [
    'lorem ipsum', 'placeholder text', 'your text here', 'your headline here',
    'your company here', 'add your', 'coming soon tm',
    'feature one', 'feature two', 'feature three',
    'heading goes here', 'example ltd', 'acme corp', 'acme inc',
];
function findFiller(content) {
    const hits = [];
    const walk = (v, path) => {
        if (v === null || v === undefined) return;
        if (typeof v === 'string') {
            const low = v.toLowerCase().trim();
            for (const f of FILLER) {
                // whole-string or leading match, not substring: "Lorem-free since day one"
                // must not trip on 'lorem ipsum', and a real product called
                // "Coming Soon TM" is out of scope for this list.
                if (low === f || low.startsWith(f + ' ') || low.endsWith(' ' + f)) hits.push(path + ' = ' + f);
            }
            return;
        }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
        if (typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
    };
    walk(content, '$');
    return [...new Set(hits)];
}

// Deterministic link integrity. Reuses this project's hardest-earned lesson:
// "unresolved_links_bug_class" — 64 live 404s shipped because nothing ever
// RESOLVED a link. Here we cannot fetch, but we can prove every anchor names a
// section that exists. An anchor to a missing id is a dead link on the page we ship.
function findDeadAnchors(content) {
    const ids = new Set(['#top']);
    (content.sections || []).forEach((s) => { if (s && s.id) ids.add(s.id); });
    const dead = [];
    const check = (link, where) => {
        if (link && link.href && !ids.has(link.href)) dead.push(where + ' -> ' + link.href);
    };
    (content.nav && content.nav.items || []).forEach((l, i) => check(l, '$.nav.items[' + i + ']'));
    check(content.nav && content.nav.cta, '$.nav.cta');
    (content.hero && content.hero.ctas || []).forEach((l, i) => check(l, '$.hero.ctas[' + i + ']'));
    return dead;
}

// Every check that is not the model's own output contract, in one place, so the
// order is deterministic and a test can assert which layer rejected.
function postValidate(raw, brand) {
    const errors = [];
    const v = validateContent(raw);
    if (!v.ok) errors.push(...v.errors);
    // The brand name the model echoes must be the name the user typed. Silent
    // rewrites here would mean the site opens with someone else's name.
    if (raw && raw.brand && typeof raw.brand.name === 'string' && brand && typeof brand.name === 'string') {
        if (raw.brand.name.trim() !== brand.name.trim()) {
            errors.push('$.brand.name: must equal the user-supplied name exactly (' + JSON.stringify(brand.name) + ')');
        }
    }
    if (v.ok) {
        for (const f of findFiller(raw)) errors.push('placeholder copy: ' + f);
        for (const d of findDeadAnchors(raw)) errors.push('dead anchor: ' + d);
    }
    return errors;
}

// ---------------------------------------------------------------------------
// cache — same shape and reasoning as dna.js: in-memory, per instance, revalidated
// on READ, nothing invalid ever written, nothing trusted when it leaves.
// ---------------------------------------------------------------------------
const store = new Map();
const pending = new Map();

function cacheGet(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { store.delete(key); return null; }
    store.delete(key); store.set(key, hit);
    return hit;
}
function cacheSet(key, value) {
    store.set(key, Object.assign({}, value, { exp: Date.now() + CONTENT_TTL_MS }));
    while (store.size > CONTENT_MAX_ENTRIES) store.delete(store.keys().next().value);
}
function clearContentCache() { store.clear(); pending.clear(); }
function _seedContentCache(brand, dna, content, model) {
    const key = contentCacheKey(brand, dna, model);
    store.set(key, { content, meta: { seeded: true }, exp: Date.now() + CONTENT_TTL_MS });
    return key;
}
function _setContentTtlMs(ms) { const prev = CONTENT_TTL_MS; CONTENT_TTL_MS = ms; return prev; }
function contentCacheStats() { return { entries: store.size, inflight: pending.size, ttlMs: CONTENT_TTL_MS }; }
function contentCacheKey(brand, dna, model) {
    const messages = buildMessages(brand, dna);
    return 'content|' + sha256(canonicalJson(messages)) + '|' + (model || process.env.OPENAI_MODEL || 'qwen3.8-flash');
}

function defaultCaller(messages, opts) {
    // Lazy require, exactly as dna.js does: tests that inject a caller never touch
    // ai.js, and CONFIG reads process.env at call time rather than at load.
    const { callAI } = require('./ai.js');
    const model = (opts && opts.model) || process.env.OPENAI_MODEL || 'qwen3.8-flash';
    return callAI(messages, null, { model, timeoutMs: (opts && opts.timeoutMs) || 150000 });
}

/**
 * @param {object} dna       designdna/1 — the ONLY reference-derived input
 * @param {object} userBrand userbrand/1 — the user's own identity
 * @returns {Promise<{content, source, aiCalls, model, timings, errors?}>}
 */
async function buildContent(dna, userBrand, opts) {
    const o = opts || {};

    // ---- gates, all deterministic, all before any I/O -----------------------
    if (!dna || dna.schema !== 'designdna/1') throw new Error('content: requires a designdna/1 document');
    if (dna.identity && (dna.identity.referenceName !== null || dna.identity.referenceDomain !== null)) {
        throw new ContentIdentityError('Input DNA still carries reference identity; refusing to generate content.', ['referenceName/referenceDomain not null (structural)']);
    }
    const bv = validateUserBrand(userBrand);
    if (!bv.ok) throw new ContentBrandError('UserBrand failed validation.', bv.errors);
    if (!requireDescription(userBrand)) {
        throw new ContentBrandError('UserBrand.description is required (10+ characters) — the content model has nothing to write about without it.');
    }

    // The firewall's reference knowledge cannot live in P4: DNA is identity-free by
    // construction, so the only source of forbidden tokens is the caller's DesignFacts.
    // Provided -> fail loudly here. Absent -> the compiler's tier-1 scan (already
    // gated by tests F1/F2) is the enforcement point. Never silently skipped and
    // reported as "scanned".
    let scan = typeof o.scan === 'function' ? o.scan : null;
    if (!scan && o.designFacts) scan = makeScanner(buildForbidden(o.designFacts));
    if (!scan && o.forbidden) scan = makeScanner(o.forbidden);
    const identityCheckedBy = scan ? 'p4' : (o.scan === undefined && !o.designFacts && !o.forbidden) ? 'compiler-tier1' : null;
    if (o.requireScan && !scan) throw new ContentIdentityError('opts.requireScan set but no identity matcher available.', ['missing-matcher']);

    // Same tokens, same zero-exemption rule, BEFORE the request: a UserBrand whose
    // own words verbatim contain the reference identity can never produce a passing
    // ContentSpec (the name echoes into content.brand and trips the post-scan; the
    // compiler tier-1 scans brand data too). Refusing pre-call saves the call and
    // gives the user the error on the field they actually typed.
    if (scan) {
        const pre = scan(JSON.stringify(userBrand));
        if (pre && pre.size) {
            throw new ContentIdentityError('UserBrand itself contains reference identity; refusing to generate. Tokens: ' + [...pre].join(', '), [...pre]);
        }
    }

    const model = o.model || process.env.OPENAI_MODEL || 'qwen3.8-flash';
    const call = typeof o.callAI === 'function' ? o.callAI : defaultCaller;
    const t0 = Date.now();
    const messages = buildMessages(userBrand, dna);
    const key = contentCacheKey(userBrand, dna, model);

    const finish = (content, source, aiCalls, aiMs) => {
        // Post-validation is the final authority on BOTH paths, cached and fresh, so
        // an entry written by an older rule set fails loudly instead of shipping.
        const errs = postValidate(content, userBrand);
        if (errs.length) throw new ContentSpecError('ContentSpec failed validation.', errs);
        const leaks = scan ? scan(JSON.stringify(content)) : null;
        if (leaks && leaks.size) {
            throw new ContentIdentityError('Generated ContentSpec contains reference identity; refusing to emit. Tokens: ' + [...leaks].join(', '), [...leaks]);
        }
        return {
            content, source, aiCalls, model,
            factsHash: dna.factsHash,
            identity: { scanned: !!scan, by: identityCheckedBy },
            timings: { aiMs, totalMs: Date.now() - t0 },
        };
    };

    if (!o.forceRefresh) {
        const cached = cacheGet(key);
        if (cached) return finish(cached.content, 'hit', 0, 0);
    }

    const waiter = pending.get(key);
    if (waiter) {
        const res = await waiter;
        return Object.assign({}, res, { source: 'shared', aiCalls: 0 });
    }

    const job = (async () => {
        let aiCalls = 0;
        let aiMs = 0;
        const runOnce = async (msgs) => {
            const start = Date.now();
            aiCalls++;                                   // BEFORE the await: a crash still counts
            const text = await call(msgs, { model, timeoutMs: o.timeoutMs });
            aiMs += Date.now() - start;
            return text;
        };
        const attempt = async (msgs) => {
            let raw;
            try { raw = parseModelJson(await runOnce(msgs)); }
            catch (e) {
                // SyntaxError = JSON that parsed-model-json could find but not parse
                // (truncated object). It is a MODEL failure, not a provider one, so it maps
                // to ContentSpecError and stays eligible for opt-in repair.
                if (e instanceof DnaValidationError || e instanceof SyntaxError) { const n = new ContentSpecError(e.message, []); n.raw = null; throw n; }
                throw e;                                  // provider errors pass through untouched
            }
            const errs = postValidate(raw, userBrand);
            if (errs.length) { const e = new ContentSpecError('ContentSpec failed validation.', errs); e.content = raw; throw e; }
            return raw;
        };

        let content;
        try {
            content = await attempt(messages);
        } catch (err) {
            const { ProviderRateLimitError, FreeTierUnavailableError } = require('./ai.js');
        // (lazy, inside catch: mirrors defaultCaller — tests never load ai.js unless they must)
            const providerDown = err instanceof ProviderRateLimitError || err instanceof FreeTierUnavailableError
                || err.name === 'AbortError' || err.name === 'TimeoutError';
            if (!(err instanceof ContentSpecError) || providerDown) throw err;
            const budget = (o.repair === false) ? 0 : (typeof o.repair === 'number' ? o.repair : repairRetries());
            if (budget < 1) throw err;
            content = await attempt(repairMessages(messages, err.content || {}, err.errors));
        }

        const res = finish(content, 'miss', aiCalls, aiMs);
        cacheSet(key, { content, meta: { model } });
        return res;
    })();

    pending.set(key, job);
    try { return await job; } finally { pending.delete(key); }
}

// Repair is off by default here, so this lives in content.js rather than in
// dna-prompt.js: the DNA repair prompt teaches grounding rules that are
// irrelevant (and misleading) to a copywriting failure.
function repairMessages(messages, invalidContent, errors) {
    return [
        messages[0],
        messages[1],
        {
            role: 'user',
            content: [
                'Your previous answer was rejected. It violated these rules:',
                '',
                errors.slice(0, 12).map((e) => '- ' + e).join('\n'),
                '',
                'Your previous answer was:',
                canonicalJson(invalidContent),
                '',
                'Answer again with the corrected JSON object only. Keep every piece of copy.',
                'If a figure or quote was not in the description, DELETE that section rather than',
                'inventing a replacement. Plain text, in-page anchors only.',
            ].join('\n'),
        },
    ];
}

module.exports = {
    CONTENT_SCHEMA_VERSION, CONTENT_MAX_ENTRIES, CONTENT_TTL_MS, repairRetries,
    ContentBrandError, ContentSpecError, ContentIdentityError,
    buildContent, buildMessages, dnaToText, contentCacheKey,
    findFiller, findDeadAnchors, postValidate, parseModelJson, repairMessages, clearContentCache,
    contentCacheStats, _seedContentCache, _setContentTtlMs,
};
