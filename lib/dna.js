// lib/dna.js — AI call #1. DesignFacts -> sanitized projection -> ONE request -> validated DesignDNA.
//
// Budget rule (product constraint, not a preference): a full generation costs
// exactly two AI calls, one here and one in P3. This file is therefore written so
// that the call count is a RETURNED, ASSERTED NUMBER rather than an emergent
// property. `aiCalls` is incremented immediately before each request, so a bug
// that fires a second retry is visible in the result object and catchable in a
// test.
//
// Explicitly NOT used: ai.js callAIWithFallback(). It iterates a model chain on
// provider 429s, so "1 AI call" would be false whenever the provider hiccupped.
// One model, one attempt per stage, honest failure instead.
//
// Cache design, and why remember() is not used here:
//   Keyed on factsHash (sha256 of canonical DesignFacts), NOT the URL. A URL key
//   forks on cache-busters - this project already had "?v=boltcheck" create a
//   second entry for identical bytes - and, worse, would serve a DNA built from
//   stale facts after a page changed.
//   In-flight coalescing is implemented here with the same pending-promise map
//   cache.js uses, because remember() would cache its producer's return value
//   before we have validated it. Requirement: cached payloads are re-validated
//   on READ, so an entry written by an older schema version fails loudly instead
//   of half-working. Nothing invalid ever enters the cache, and nothing invalid
//   is trusted when it leaves.

const { factsHash, canonicalJson } = require('./canonical.js');
const { buildProjection, leaksInProjection } = require('./projection.js');
const { validateDna } = require('./ground.js');
const { buildMessages, repairMessages } = require('./dna-prompt.js');
const { FreeTierUnavailableError, ProviderRateLimitError } = require('./ai.js');

const SCHEMA_VERSION = 'designdna/1';
// Read at CALL time, not load time: a constant snapshotted on require is the
// silently-dead-test-seam class - a test that sets the env var afterwards would be
// varying something nothing reads.
const repairRetries = () => Number(process.env.DNA_REPAIR_RETRIES ?? 1);
let DNA_TTL_MS = Number(process.env.DNA_CACHE_TTL_MS || 7 * 24 * 3600e3);
const DNA_MAX_ENTRIES = Number(process.env.DNA_CACHE_MAX_ENTRIES || 100);

class DnaValidationError extends Error {
    constructor(message, errors) { super(message); this.name = 'DnaValidationError'; this.errors = errors || []; }
}
class DnaIdentityError extends Error {
    constructor(message, leaks) { super(message); this.name = 'DnaIdentityError'; this.leaks = leaks || []; }
}

// ---------------------------------------------------------------------------
// per-instance cache. In-memory, deliberately: no user data, no secrets, and
// every value is derived from a public page. It is NOT distributed, and a cold
// start empties it - it must not be described as one.
// ---------------------------------------------------------------------------
const store = new Map();      // key -> { dna, meta, exp }
const pending = new Map();    // key -> Promise<result>

function cacheGet(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.exp) { store.delete(key); return null; }
    store.delete(key); store.set(key, hit);            // LRU touch
    return hit;
}
function cacheSet(key, value) {
    store.set(key, Object.assign({}, value, { exp: Date.now() + DNA_TTL_MS }));
    while (store.size > DNA_MAX_ENTRIES) store.delete(store.keys().next().value);
}
function clearDnaCache() { store.clear(); pending.clear(); }
// Test seams. Without these, "cached payloads are validated before use" and "TTL
// expiry" are untestable claims about an internal Map, and an unverifiable guard
// is exactly how the inverted-card bug shipped. Both throw if misused.
function _seedDnaCache(facts, dna) {
    const key = 'dna|' + factsHash(facts);
    store.set(key, { dna: dna, meta: { seeded: true }, exp: Date.now() + DNA_TTL_MS });
    return key;
}
function _setDnaTtlMs(ms) { const prev = DNA_TTL_MS; DNA_TTL_MS = ms; return prev; }
function dnaCacheStats() { return { entries: store.size, inflight: pending.size, ttlMs: DNA_TTL_MS }; }

// ---------------------------------------------------------------------------
// Model JSON is never trust-parsed. Reasoning models on this relay prepend
// prose and sometimes wrap the object in ``` fences; a bare JSON.parse throws
// "Unexpected token" on real output. Slice to the outermost braces first.
// If that still fails it is a genuine invalid answer and goes through repair.
// ---------------------------------------------------------------------------
function parseModelJson(text) {
    if (typeof text !== 'string' || !text.trim()) throw new DnaValidationError('Model returned an empty response.', []);
    let s = text.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fenced) s = fenced[1].trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new DnaValidationError('Model response contained no JSON object.', []);
    }
    return JSON.parse(s.slice(start, end + 1));
}

function defaultCaller(messages, opts) {
    // Lazy require so tests that inject a caller never touch ai.js, and so
    // CONFIG reads process.env at call time (ai.js snapshots BASE_URL on load).
    const { callAI } = require('./ai.js');
    const model = (opts && opts.model) || process.env.OPENAI_MODEL || 'qwen3.8-flash';
    return callAI(messages, null, { model, timeoutMs: (opts && opts.timeoutMs) || 150000 });
}

/**
 * Build (or reuse) DesignDNA for a DesignFacts object.
 *
 * @returns {Promise<{dna, factsHash, source, aiCalls, model, timings, errors?}>}
 *   source: 'hit' | 'miss' | 'shared'   (shared = joined a sibling's in-flight call)
 */
async function buildDna(facts, opts) {
    const o = opts || {};
    const t0 = Date.now();
    const model = o.model || process.env.OPENAI_MODEL || 'qwen3.8-flash';
    const call = typeof o.callAI === 'function' ? o.callAI : defaultCaller;

    // ---- projection + grounding context (deterministic, no I/O) -------------
    const { projection, forbidden, grounding } = buildProjection(facts);
    projection.factsHash = factsHash(facts);
    projection.model = model;                      // echoed so DNA can be bound to facts

    // Test seam, deliberately the NARROWEST one that makes the gate's invariant
    // testable. Gate 0 protects "never send reference identity to the model", and
    // because the projection is now clean by construction there is no INPUT that
    // fires it - so the guard could not be shown to work, which is the "test that
    // cannot fail" class this project has hit four times. A mutator applied BEFORE
    // the check lets a test simulate the regression the guard exists for (a future
    // projection field echoing identity). Never passed in production: the only
    // production caller builds opts from a fixed allow-list.
    if (typeof o._poisonProjection === 'function') o._poisonProjection(projection, forbidden);

    // Gate 0: the sanitized input itself must be identity-free. If this fires,
    // the projection is broken and we must not send anything at all.
    const inputLeaks = leaksInProjection(projection, forbidden);
    if (inputLeaks.length) {
        throw new DnaIdentityError('Sanitized AI input still contains reference identity; refusing to call the model.', inputLeaks);
    }

    const ctx = { projection, forbidden, grounding, factsHash: projection.factsHash, scan: forbidden.scan };
    const key = 'dna|' + ctx.factsHash;

    // ---- cache read, with validation before use -----------------------------
    if (!o.forceRefresh) {
        const cached = cacheGet(key);
        if (cached) {
            const check = validateDna(cached.dna, ctx);
            if (check.ok) {
                return { dna: cached.dna, factsHash: ctx.factsHash, source: 'hit', aiCalls: 0, model: cached.dna.model, timings: { totalMs: Date.now() - t0, aiMs: 0 } };
            }
            // Stale/invalid entry (older schema, or written by a buggy build).
            // Recompute rather than serve it; overwrite happens on the next set.
            store.delete(key);
            ctx._evictedInvalid = check.errors.length;
        }
    }

    // ---- coalesce: identical requests in flight = ONE AI call ---------------
    const waiter = pending.get(key);
    if (waiter) {
        const res = await waiter;
        return Object.assign({}, res, { source: 'shared', aiCalls: 0 });
    }

    const job = (async () => {
        let aiCalls = 0;
        let aiMs = 0;
        const messages = buildMessages(projection);

        const runOnce = async (msgs) => {
            const start = Date.now();
            aiCalls++;                                  // incremented BEFORE the await so a
            const text = await call(msgs, { model, timeoutMs: o.timeoutMs });   // crash still counts
            aiMs += Date.now() - start;
            return text;
        };

        const attempt = async (msgs) => {
            const dna = parseModelJson(await runOnce(msgs));
            dna.model = model;                          // server-authoritative: model output
            dna.schema = SCHEMA_VERSION;                // cannot pick its own provenance
            dna.factsHash = ctx.factsHash;               // bound to THESE facts
            const v = validateDna(dna, ctx);
            if (!v.ok) { const e = new DnaValidationError('DesignDNA failed validation.', v.errors); e.dna = dna; throw e; }
            return dna;
        };

        let dna;
        try {
            dna = await attempt(messages);
        } catch (err) {
            const providerDown = err instanceof ProviderRateLimitError || err instanceof FreeTierUnavailableError || err.name === 'AbortError' || err.name === 'TimeoutError';
            if (!(err instanceof DnaValidationError) || providerDown) throw err;
            // repair:false is the GENERATION-PATH budget switch promised by
            // ARCHITECTURE (a full generation is <=2 RAW calls, one per stage).
            // An env var alone cannot express "this call is part of a generation",
            // so the option is honored here; standalone DNA analysis keeps the
            // repair retry because it is not spending the generation budget.
            const budget = (o.repair === false) ? 0 : repairRetries();
            if (budget < 1) throw err;
            // Exactly one repair attempt. Its own validation failure propagates.
            dna = await attempt(repairMessages(projection, err.dna || {}, err.errors));
        }

        const result = {
            dna, factsHash: ctx.factsHash, source: 'miss', aiCalls, model,
            timings: { aiMs, totalMs: Date.now() - t0 },
        };
        cacheSet(key, { dna, meta: { model, factsHash: ctx.factsHash } });
        return result;
    })();

    pending.set(key, job);
    try {
        return await job;
    } finally {
        pending.delete(key);
    }
}

module.exports = {
    DNA_MAX_ENTRIES, DNA_TTL_MS, repairRetries, SCHEMA_VERSION,
    DnaIdentityError, DnaValidationError,
    buildDna, canonicalJson, clearDnaCache, dnaCacheStats, parseModelJson,
    _seedDnaCache, _setDnaTtlMs,
};
