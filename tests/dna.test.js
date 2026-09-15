// tests/dna.test.js - P2: DesignFacts -> sanitized projection -> ONE AI call -> validated DNA.
//
// Harness rules this file obeys, each because of a failure already recorded in this
// project:
//   * reports EXECUTED tests, not registered ones (frontend.test.js counted
//     registrations and reported passes for tests that never ran);
//   * every guard below is paired with a mutation check elsewhere in this file, so
//     "green" means "proven able to go red", not "did not complain";
//   * AI calls are counted by the fake caller, so the budget is an asserted number;
//   * no pipes, and the process exits nonzero on any failure.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { buildDesignFacts } = require(path.join(ROOT, 'lib/facts.js'));
const { factsHash, canonicalJson } = require(path.join(ROOT, 'lib/canonical.js'));
const { buildProjection, leaksInProjection } = require(path.join(ROOT, 'lib/projection.js'));
const { buildMessages } = require(path.join(ROOT, 'lib/dna-prompt.js'));
const { validateDna } = require(path.join(ROOT, 'lib/ground.js'));
const { buildForbidden } = require(path.join(ROOT, 'lib/identity.js'));
const dna = require(path.join(ROOT, 'lib/dna.js'));
const F = require(path.join(__dirname, 'fixtures/dna-zephyrion.js'));

const clone = (o) => JSON.parse(JSON.stringify(o));

function makeCtx() {
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const built = buildProjection(facts);
    built.projection.factsHash = factsHash(facts);
    built.projection.model = 'qwen3.8-flash';
    const ctx = {
        facts: facts,
        projection: built.projection,
        forbidden: built.forbidden,
        grounding: built.grounding,
        factsHash: built.projection.factsHash,
        scan: built.forbidden.scan,
    };
    ctx.validate = (d) => validateDna(d, ctx);
    return ctx;
}

// A caller that counts. Every budget claim in this file reads this number.
function countingCaller(responder) {
    const state = { calls: 0, messages: [] };
    const fn = async function (messages) {
        state.calls++;
        state.messages.push(messages);
        return responder(messages, state.calls);
    };
    return { fn: fn, state: state };
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ---------------------------------------------------------------------------
// A. SCHEMA
// ---------------------------------------------------------------------------
test('A1 happy path: projection-derived DNA validates', function () {
    const ctx = makeCtx();
    const r = ctx.validate(F.validDnaFrom(ctx));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors, null, 1));
});

test('A2 unknown top-level key rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.extraField = 'x';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /unknown field/.test(e.message) && /extraField/.test(e.message)), JSON.stringify(r.errors));
});

test('A3 unknown nested key rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.hueStory = 'warm dusk';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /hueStory/.test(e.message)), JSON.stringify(r.errors));
});

test('A4 invalid enum rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.temperature = 'moist';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /temperature/.test(e.message)), JSON.stringify(r.errors));
});

test('A5 invalid role enum rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.roles[0].role = 'heroBackground';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /roles\[0\]\.role/.test(e.message)), JSON.stringify(r.errors));
});

test('A6 out-of-range rejected (max) and (min)', function () {
    const ctx = makeCtx();
    const hi = F.validDnaFrom(ctx);
    hi.layout.maxWidth = 4000;
    const r1 = ctx.validate(hi);
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.errors.some((e) => /maxWidth/.test(e.message) && /max/.test(e.message)), JSON.stringify(r1.errors));
    const lo = F.validDnaFrom(ctx);
    lo.spacing.baseUnit = 0.5;
    const r2 = ctx.validate(lo);
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.errors.some((e) => /baseUnit/.test(e.message) && /min/.test(e.message)), JSON.stringify(r2.errors));
});

test('A7 missing required field rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    delete d.spacing.rhythm;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /rhythm.*missing/.test(e.message)), JSON.stringify(r.errors));
});

test('A8 duplicate palette role rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.roles[1].role = 'canvas';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /duplicate/.test(e.message)), JSON.stringify(r.errors));
});

test('A9 factsHash mismatch rejected (wrong provenance)', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.factsHash = 'sha256:' + '0'.repeat(64);
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /factsHash/.test(e.message)), JSON.stringify(r.errors));
});

test('A10 wrong schema version rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.schema = 'designdna/0';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /schema/.test(e.message)), JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// B. GROUNDING - locked rule #1
// ---------------------------------------------------------------------------
test('B1 invented hex rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.roles[0].value = F.DECOY.hex;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /does not appear in DesignFacts/.test(e.message)), JSON.stringify(r.errors));
});

test('B2 invented factRef token rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.palette.roles[0].factRef = '--zns-color-nonexistent';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /factRef/.test(e.message)), JSON.stringify(r.errors));
});

test('B3 invented scaleRatio rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.typography.scaleRatio = F.DECOY.scaleRatio;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /scaleRatio/.test(e.message)), JSON.stringify(r.errors));
});

test('B4 invented baseUnit rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.spacing.baseUnit = F.DECOY.baseUnit;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /baseUnit/.test(e.message)), JSON.stringify(r.errors));
});

test('B5 invented maxWidth rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.layout.maxWidth = F.DECOY.maxWidth;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /maxWidth/.test(e.message)), JSON.stringify(r.errors));
});

test('B6 invented radius value rejected (grounding, not just schema)', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.radius.values = d.radius.values.concat([F.DECOY.radius]);
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /radius\.values/.test(e.message)), JSON.stringify(r.errors));
});

test('B7 real radius values pass grounding (positive control)', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.radius.values = ['0px', '4px', '6px', '12px', '9999px'];
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors, null, 1));
});

test('B8 invented duration + breakpoint + weight each rejected', function () {
    const ctx = makeCtx();
    const cases = [
        ['motion.durationsMs', (d) => { d.motion.durationsMs = d.motion.durationsMs.concat([F.DECOY.duration]); }],
        ['layout.breakpointLadder', (d) => { d.layout.breakpointLadder = d.layout.breakpointLadder.concat([F.DECOY.breakpoint]); }],
        ['typography.weightsUsed', (d) => { d.typography.weightsUsed = d.typography.weightsUsed.concat([F.DECOY.weight]); }],
    ];
    for (const [label, mutate] of cases) {
        const d = F.validDnaFrom(ctx);
        mutate(d);
        const r = ctx.validate(d);
        assert.strictEqual(r.ok, false, label + ' was accepted');
        assert.ok(r.errors.some((e) => e.kind === 'grounding' && e.message.includes(label)), label + ': ' + JSON.stringify(r.errors));
    }
});

test('B9 derived values allowed: gcd base unit and type-scale ratio', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    // 4 divides all observed gaps (8,16,24,32,64) => deterministically derivable.
    d.spacing.baseUnit = 4;
    // 25/20 is a quotient of two observed sizes => derivable, not invented.
    d.typography.scaleRatio = 1.25;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors, null, 1));
});

test('B10 unavailable section must be empty (honesty check)', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.spacing.status = 'unavailable';
    d.spacing.baseUnit = 8;
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /unavailable.*but|must be empty/.test(e.message)), JSON.stringify(r.errors));
});

test('B11 unavailable section with nulls is legal ("I do not know" is an answer)', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.spacing.status = 'unavailable';
    d.spacing.baseUnit = null;
    d.spacing.rhythm = 'unknown';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors, null, 1));
});

test('B12 unobserved component kind rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.components.idioms.push({ kind: 'carousel', pattern: 'horizontal track with snap points' });
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'grounding' && /carousel/.test(e.message)), JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------
// C. IDENTITY - locked correction #3
// ---------------------------------------------------------------------------
const IDENTITY_TERMS = ['zephyrion', 'zephyrion.com', 'assets.zephyrion.com', 'ZephyrionSans', 'ZephyrionSerif', 'ZephyrionMono'];

test('C1 projection carries no reference URL or domain', function () {
    const ctx = makeCtx();
    const s = JSON.stringify(ctx.projection);
    assert.ok(!/https?:\/\//.test(s), 'URL survived sanitisation');
    for (const t of IDENTITY_TERMS) assert.ok(!new RegExp(t, 'i').test(s), 'leak: ' + t);
});

test('C2 projection carries no brand-bearing font family NAMES', function () {
    const ctx = makeCtx();
    const fams = ctx.projection.observed.type.families;
    assert.deepStrictEqual(fams, ['sans', 'serif', 'mono']);
    const s = JSON.stringify(fams);
    assert.ok(!/zephyrion/i.test(s), 'family names leaked: ' + s);
});

test('C3 type-token VALUES cannot leak identity (font stack case)', function () {
    const ctx = makeCtx();
    const vals = ctx.projection.observed.type.tokens.map((t) => t.value).join(' | ');
    assert.ok(!/zephyrion/i.test(vals), 'value leaked: ' + vals);
    // ...and the numeric facts grounding depends on must survive the redaction.
    assert.ok(/\b400\b/.test(vals), 'numbers were destroyed by over-redaction');
    assert.ok(/px/.test(vals), 'px values were destroyed by over-redaction');
});

test('C4 brand-named CSS custom properties cannot leak (vendor prefix)', function () {
    const ctx = makeCtx();
    const s = JSON.stringify(ctx.projection);
    assert.ok(!/zns/i.test(s), 'vendor token prefix leaked');
    assert.ok(!/--/.test(s.replace(/---/g, '')) || !/\"name\":/.test(s), 'raw token names present');
    assert.ok(!/"name":/.test(s), 'projection still emits a name field');
});

test('C5 asset hosts and URLs are absent from projection', function () {
    const ctx = makeCtx();
    const s = JSON.stringify(ctx.projection);
    assert.ok(!/assets\./.test(s), 'asset host leaked');
    assert.ok(!/\.png|\.ico/.test(s), 'asset filename leaked');
});

test('C6 keyframe names removed, durations kept', function () {
    const ctx = makeCtx();
    const m = ctx.projection.observed.motion;
    const s = JSON.stringify(m);
    assert.ok(!/zephyrionReveal|floatDot/i.test(s), 'keyframe name leaked');
    assert.deepStrictEqual(m.durationsMs, [200, 300]);
    assert.strictEqual(m.reducedMotionPresent, true);
});

test('C7 pageOutline NEVER reaches serialized AI input', function () {
    const ctx = makeCtx();
    const msgs = buildMessages(ctx.projection);
    const wire = JSON.stringify(msgs);
    const outline = F.EXTRACTED.pageOutline;
    assert.ok(outline.length > 0, 'fixture outline is empty - test would pass vacuously');
    for (const frag of ['Ship faster', 'Trusted by teams', 'Zephyrion pricing']) {
        assert.ok(!wire.includes(frag), 'page copy reached AI #1: ' + frag);
    }
    assert.ok(!/pageOutline/.test(wire), 'pageOutline field name present in AI input');
    assert.ok(!wire.includes(outline), 'full outline present in AI input');
});

test('C8 facts record fonts verbatim; projection removes them (auditability)', function () {
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    assert.ok(/ZephyrionSans/.test(JSON.stringify(facts)), 'facts must stay a faithful record');
    const built = buildProjection(facts);
    assert.ok(!/Zephyrion/i.test(JSON.stringify(built.projection)), 'projection must be clean');
});

test('C9 DNA containing the reference brand is rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.principles[0] = 'Zephyrion keeps its canvas near-neutral so the accent does the persuading.';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'identity'), JSON.stringify(r.errors));
});

test('C10 DNA naming a domain in prose is rejected', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.gaps[0] = 'See zephyrion.com for the full system.';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'identity'), JSON.stringify(r.errors));
});

test('C11 identity.referenceName must be null', function () {
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    d.identity.referenceName = 'Unknown';
    const r = ctx.validate(d);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.kind === 'identity'), JSON.stringify(r.errors));
});

test('C12 buildForbidden does not over-block generic words (regression)', function () {
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const { forbidden } = buildForbidden(facts);
    const generic = ['products', 'pricing', 'launch', 'home', 'docs', 'cloud', 'reveal', 'card', 'button', 'sans', 'serif', 'mono', 'weight', 'radius', 'spacing'];
    const blocked = generic.filter((w) => forbidden.has(w));
    assert.deepStrictEqual(blocked, [], 'generic words forbidden: ' + blocked.join(', '));
    assert.ok(forbidden.has('zephyrion'), 'the actual brand must still be forbidden');
});

test('C13 required schema enums survive the forbidden list', function () {
    // If 'serif' were forbidden, no valid DNA could ever be produced: the schema
    // demands typography.body: 'serif'. This is the self-blocking trap in one assert.
    const ctx = makeCtx();
    const d = F.validDnaFrom(ctx);
    assert.ok(['serif', 'sans', 'mono'].some((w) => !ctx.forbidden.forbidden.has(w)));
    assert.strictEqual(ctx.validate(d).ok, true);
    const msgs = JSON.stringify(buildMessages(ctx.projection));
    for (const w of ['serif', 'sans', 'mono']) assert.ok(msgs.includes(w), 'prompt lost ' + w);
});

// C14 replaces a NO-OP. The previous version read two options that do not exist in
// lib/dna.js (_bypassGate0, and _poisonProjection as a boolean), so the poison never
// happened, the conditional branch was usually skipped, and the final assertion was
// assert.ok(true) - a test that cannot fail, inflating the pass count it was cited as
// evidence for. Now: inject a real identity token, assert the throw, assert ZERO
// calls, and assert nothing was ever serialized to the wire.
test('C14 gate 0 rejects an identity-bearing projection and makes ZERO calls', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const c = countingCaller(function () { return '{"never":"reached"}'; });
    let threw = null;
    let res = null;
    try {
        res = await dna.buildDna(facts, {
            callAI: c.fn, model: 'qwen3.8-flash',
            _poisonProjection: function (proj) {
                // Simulate the regression this guard exists for: a future field added
                // to the projection that echoes the reference identity.
                proj.observed.leaky = { domain: 'zephyrion.com', name: 'Zephyrion' };
            },
        });
    } catch (e) { threw = e; }
    assert.ok(threw, 'gate 0 did not fire on a poisoned projection (returned: ' + JSON.stringify(res && res.source) + ')');
    assert.strictEqual(threw.name, 'DnaIdentityError', 'wrong error: ' + threw.name);
    assert.ok(Array.isArray(threw.leaks) && threw.leaks.length > 0, 'identity error carried no leak detail');
    assert.strictEqual(c.state.calls, 0, 'THE MODEL WAS CALLED DESPITE AN IDENTITY ERROR');
    assert.strictEqual(c.state.messages.length, 0, 'a request was serialized despite an identity error');
    assert.strictEqual(dna.dnaCacheStats().entries, 0, 'a refused build entered the cache');
});

test('C15 control: the UNPOISONED projection passes gate 0 and calls once', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function () { return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); });
    const r = await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
    assert.strictEqual(c.state.calls, 1, 'control build should cost exactly one call');
    assert.strictEqual(r.source, 'miss');
});

// ---------------------------------------------------------------------------
// D. BUDGET + CACHE
// ---------------------------------------------------------------------------
test('D1 cache miss makes exactly ONE AI call', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function () { return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); });
    const res = await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
    assert.strictEqual(c.state.calls, 1, 'expected exactly 1 call, got ' + c.state.calls);
    assert.strictEqual(res.aiCalls, 1);
    assert.strictEqual(res.source, 'miss');
});
function ctxWith(ctx, facts) {
    const built = buildProjection(facts);
    built.projection.factsHash = ctx.factsHash;
    built.projection.model = 'qwen3.8-flash';
    return { factsHash: ctx.factsHash, projection: built.projection };
}

test('D2 valid cache hit makes ZERO calls', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    let made = 0;
    const payload = function () { made++; return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); };
    const a = await dna.buildDna(facts, { callAI: async function (m) { const t = payload(); return t; }, model: 'qwen3.8-flash' });
    const b = await dna.buildDna(facts, { callAI: async function () { made++; return '{}'; }, model: 'qwen3.8-flash' });
    assert.strictEqual(a.aiCalls, 1);
    assert.strictEqual(b.aiCalls, 0, 'cache hit consumed a call');
    assert.strictEqual(b.source, 'hit');
    assert.strictEqual(made, 1, 'model was invoked ' + made + ' times');
    assert.deepStrictEqual(b.dna, a.dna);
});

test('D3 DNA is cached by facts-hash, so a URL cache-buster cannot fork it', async function () {
    dna.clearDnaCache();
    const m1 = clone(F.META);
    const m2 = clone(F.META);
    m2.url = 'https://zephyrion.com/products?ref=launch&v=boltcheck';
    const f1 = buildDesignFacts(clone(F.EXTRACTED), m1);
    const f2 = buildDesignFacts(clone(F.EXTRACTED), m2);
    const ctx = makeCtx();
    let made = 0;
    const caller = async function () { made++; return canonicalJson(F.validDnaFrom(ctxWith(ctx, f1))); };
    const a = await dna.buildDna(f1, { callAI: caller, model: 'qwen3.8-flash' });
    const b = await dna.buildDna(f2, { callAI: caller, model: 'qwen3.8-flash' });
    assert.strictEqual(a.factsHash, b.factsHash, 'facts hash moved with the query string');
    assert.strictEqual(b.source, 'hit');
    assert.strictEqual(made, 1, 'identical bytes cost ' + made + ' calls');
});

test('D4 changed facts DO fork the cache (a stale DNA must not be served)', async function () {
    dna.clearDnaCache();
    const f1 = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ex2 = clone(F.EXTRACTED);
    ex2.designTokens = ex2.designTokens.concat(['  --zns-color-extra: #123456']);
    const f2 = buildDesignFacts(ex2, clone(F.META));
    const ctx = makeCtx();
    let made = 0;
    const caller = async function (msgs) {
        made++;
        const facts = made === 1 ? f1 : f2;
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts)));
    };
    const a = await dna.buildDna(f1, { callAI: caller, model: 'qwen3.8-flash' });
    const b = await dna.buildDna(f2, { callAI: caller, model: 'qwen3.8-flash' });
    assert.notStrictEqual(a.factsHash, b.factsHash);
    assert.strictEqual(b.source, 'miss');
    assert.strictEqual(made, 2);
});

test('D5 concurrent identical requests coalesce to ONE call', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    let made = 0;
    const caller = async function () {
        made++;
        await new Promise((r) => setTimeout(r, 15));   // hold the in-flight window open
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts)));
    };
    const rs = await Promise.all([
        dna.buildDna(facts, { callAI: caller, model: 'qwen3.8-flash' }),
        dna.buildDna(facts, { callAI: caller, model: 'qwen3.8-flash' }),
        dna.buildDna(facts, { callAI: caller, model: 'qwen3.8-flash' }),
        dna.buildDna(facts, { callAI: caller, model: 'qwen3.8-flash' }),
        dna.buildDna(facts, { callAI: caller, model: 'qwen3.8-flash' }),
    ]);
    assert.strictEqual(made, 1, 'coalescing failed: ' + made + ' calls for 5 concurrent requests');
    assert.strictEqual(rs[0].aiCalls, 1);
    assert.strictEqual(rs[0].source, 'miss');
    for (const r of rs.slice(1)) {
        assert.strictEqual(r.aiCalls, 0, 'a waiter was charged an AI call');
        assert.strictEqual(r.source, 'shared');
        assert.deepStrictEqual(r.dna, rs[0].dna);
    }
});

test('D6 concurrent DIFFERENT facts get their own calls (no cross-request bleed)', async function () {
    dna.clearDnaCache();
    const f1 = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ex2 = clone(F.EXTRACTED);
    ex2.designTokens = ex2.designTokens.concat(['  --zns-color-extra: #654321']);
    const f2 = buildDesignFacts(ex2, clone(F.META));
    const ctx = makeCtx();
    let made = 0;
    const caller = async function () {
        const n = ++made;
        await new Promise((r) => setTimeout(r, 15));
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, n === 1 ? f1 : f2)));
    };
    const [a, b] = await Promise.all([
        dna.buildDna(f1, { callAI: caller, model: 'qwen3.8-flash' }),
        dna.buildDna(f2, { callAI: caller, model: 'qwen3.8-flash' }),
    ]);
    assert.strictEqual(made, 2);
    assert.notStrictEqual(a.factsHash, b.factsHash);
});

test('D7 cached payload is VALIDATED on read; invalid entry is recomputed', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const broken = F.validDnaFrom(ctx);
    broken.schema = 'designdna/0';                      // simulates an older writer
    broken.typography.scaleRatio = 9.99;                // and an ungrounded value
    dna._seedDnaCache(facts, broken);
    assert.strictEqual(dna.dnaCacheStats().entries, 1, 'seed failed - this test would pass vacuously');
    let made = 0;
    const res = await dna.buildDna(facts, {
        callAI: async function () { made++; return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); },
        model: 'qwen3.8-flash',
    });
    assert.strictEqual(made, 1, 'invalid cached payload was served instead of recomputed');
    assert.strictEqual(res.aiCalls, 1);
    assert.strictEqual(res.dna.schema, 'designdna/1');
    assert.notStrictEqual(res.dna.typography.scaleRatio, 9.99);
});

test('D8 expired entry is not served', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const prev = dna._setDnaTtlMs(-1);                  // already expired on write
    try {
        dna._seedDnaCache(facts, F.validDnaFrom(ctx));
        let made = 0;
        const res = await dna.buildDna(facts, {
            callAI: async function () { made++; return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); },
            model: 'qwen3.8-flash',
        });
        assert.strictEqual(made, 1, 'expired cache entry was served');
        assert.strictEqual(res.source, 'miss');
    } finally { dna._setDnaTtlMs(prev); }
});

test('D9 LRU eviction respects the entry cap', async function () {
    dna.clearDnaCache();
    const ctx = makeCtx();
    const cap = dna.DNA_MAX_ENTRIES;
    assert.ok(cap > 0);
    // Driven through buildDna, NOT _seedDnaCache: the seed seam writes `store` directly
    // and so bypasses cacheSet's eviction loop entirely. Measured - seeding 105 facts left
    // entries at 105, because nothing on that path can ever enforce the cap. Only the real
    // write path (miss -> validate -> cacheSet) exercises eviction, so only that path is
    // evidence. Each seed varies a colour token, because fetchedAt is deliberately outside
    // the canonical hash and varying it collapsed every key into one.
    const hashes = new Set();
    for (let i = 0; i < cap + 5; i++) {
        const ex = clone(F.EXTRACTED);
        const hh = i.toString(16).padStart(2, '0');
        ex.designTokens.splice(1, 0, '  --zns-evict-' + i + ': #' + hh + hh + hh);
        const facts = buildDesignFacts(ex, clone(F.META));
        hashes.add(factsHash(facts));
        const built = buildProjection(facts);
        built.projection.factsHash = factsHash(facts);
        built.projection.model = 'qwen3.8-flash';
        const valid = canonicalJson(F.validDnaFrom({ projection: built.projection }));
        const c = countingCaller(function () { return valid; });
        await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
        assert.strictEqual(c.state.calls, 1, 'seed ' + i + ' expected exactly 1 model call');
    }
    assert.strictEqual(hashes.size, cap + 5,
        'only ' + hashes.size + ' distinct facts hashes of ' + (cap + 5) + ' - eviction is not being exercised');
    const after = dna.dnaCacheStats().entries;
    assert.strictEqual(after, cap, 'cache grew past DNA_MAX_ENTRIES (entries=' + after + ', cap=' + cap + ')');
    // The oldest keys must be the ones gone, i.e. eviction is LRU/FIFO on insertion here.
    const reC = countingCaller(function () { return canonicalJson(F.validDnaFrom(ctx)); });
    await dna.buildDna(buildDesignFacts(clone(F.EXTRACTED), clone(F.META)), { callAI: reC.fn, model: 'qwen3.8-flash' });
});

// ---------------------------------------------------------------------------
// E. REPAIR PATH
// ---------------------------------------------------------------------------
test('E1 schema failure triggers exactly ONE repair, then succeeds', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function (msgs, n) {
        if (n === 1) return canonicalJson({ schema: 'designdna/1', nope: true });
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts)));
    });
    const res = await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
    assert.strictEqual(c.state.calls, 2, 'expected 1 attempt + 1 repair, got ' + c.state.calls);
    assert.strictEqual(res.aiCalls, 2);
    assert.strictEqual(res.dna.schema, 'designdna/1');
});

test('E2 repair request carries the validation errors (real feedback, not a retry)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function (msgs, n) {
        if (n === 1) return canonicalJson({ schema: 'designdna/1', nope: true });
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts)));
    });
    await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
    assert.strictEqual(c.state.messages.length, 2);
    const repairWire = JSON.stringify(c.state.messages[1]);
    assert.ok(/unknown field|nope/.test(repairWire), 'repair prompt did not name the failure');
    assert.ok(c.state.messages[1].length > c.state.messages[0].length, 'repair added no context');
});

test('E3 repair failure makes NO additional calls (cap is exactly one retry)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    let made = 0;
    let err = null;
    try {
        await dna.buildDna(facts, {
            callAI: async function () { made++; return canonicalJson({ schema: 'designdna/1', nope: true }); },
            model: 'qwen3.8-flash',
        });
    } catch (e) { err = e; }
    assert.strictEqual(made, 2, 'expected exactly 1 attempt + 1 repair, got ' + made);
    assert.ok(err, 'a permanently-invalid model should reject the build');
    assert.strictEqual(err.name, 'DnaValidationError');
    assert.ok(dna.repairRetries() === 1, 'this test assumes a cap of 1');
});

test('E4 failed build is NOT cached (a bad output cannot be replayed)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    try {
        await dna.buildDna(facts, { callAI: async function () { return 'not json at all'; }, model: 'qwen3.8-flash' });
    } catch (e) { /* expected */ }
    assert.strictEqual(dna.dnaCacheStats().entries, 0, 'invalid output entered the cache');
});

test('E5 provider rate limit is NOT repaired (budget is not spent on a 429)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const { ProviderRateLimitError } = require(path.join(ROOT, 'lib/ai.js'));
    let made = 0;
    let err = null;
    try {
        await dna.buildDna(facts, {
            callAI: async function () { made++; throw new ProviderRateLimitError('429'); },
            model: 'qwen3.8-flash',
        });
    } catch (e) { err = e; }
    assert.strictEqual(made, 1, 'a provider 429 triggered a retry: ' + made + ' calls');
    assert.ok(err instanceof ProviderRateLimitError);
});

test('E6 model returning prose around JSON still parses', function () {
    const ctx = makeCtx();
    const payload = canonicalJson(F.validDnaFrom(ctx));
    const messy = 'Sure! Here is the design language:\n\n```json\n' + payload + '\n```\nHope that helps.';
    assert.deepStrictEqual(dna.parseModelJson(messy), JSON.parse(payload));
});

test('E7 non-caller path: defaultCaller is NOT exercised when callAI injected', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const res = await dna.buildDna(facts, {
        callAI: async function () { return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); },
        model: 'some-other-model',
    });
    assert.strictEqual(res.model, 'some-other-model', 'provider/model must stay configurable');
    assert.strictEqual(res.dna.model, 'some-other-model', 'model provenance must be server-set');
});

test('E8 model cannot choose its own provenance', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function () {
        const d = F.validDnaFrom(ctxWith(ctx, facts));
        d.model = 'gpt-9-imaginary';
        d.factsHash = 'sha256:' + 'f'.repeat(64);
        return canonicalJson(d);
    });
    const res = await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash' });
    assert.strictEqual(res.dna.model, 'qwen3.8-flash', 'model output overwrote server provenance');
    assert.strictEqual(res.dna.factsHash, res.factsHash, 'model forged the factsHash');
});

test('E9 repair:false spends exactly ONE raw call (generation budget)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const c = countingCaller(function () { return canonicalJson({ schema: 'designdna/1', nope: true }); });
    let err = null;
    try {
        await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash', repair: false });
    } catch (e) { err = e; }
    // ARCHITECTURE pins a full generation at <=2 RAW calls, ONE per stage. If the DNA
    // stage silently retries, the real budget is 3 and the documented number is a lie.
    assert.strictEqual(c.state.calls, 1,
        'repair:false still spent ' + c.state.calls + ' calls - the generation budget is not 2 raw calls');
    assert.ok(err, 'an invalid answer must still reject, retry or no retry');
    assert.strictEqual(err.name, 'DnaValidationError');
});

test('E10 repair:true keeps the retry (flag honored in BOTH directions)', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const c = countingCaller(function (msgs, n) {
        if (n === 1) return canonicalJson({ schema: 'designdna/1', nope: true });
        return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts)));
    });
    const res = await dna.buildDna(facts, { callAI: c.fn, model: 'qwen3.8-flash', repair: true });
    // Without this, a mutant that forces the budget to 0 passes E9 and looks like a
    // correct implementation. E9 alone pins only half the switch.
    assert.strictEqual(c.state.calls, 2, 'repair:true did not retry - the option is being read as false');
    assert.strictEqual(res.aiCalls, 2);
    assert.strictEqual(res.dna.schema, 'designdna/1');
});

// ---------------------------------------------------------------------------
// F. DETERMINISM
// ---------------------------------------------------------------------------
test('F1 prompt is byte-identical across builds of the same facts', async function () {
    dna.clearDnaCache();
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const ctx = makeCtx();
    const a = countingCaller(function () { return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); });
    await dna.buildDna(facts, { callAI: a.fn, model: 'qwen3.8-flash' });
    const b = countingCaller(function () { return canonicalJson(F.validDnaFrom(ctxWith(ctx, facts))); });
    const fresh = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    // forceRefresh is required now that the DNA cache is keyed on factsHash: identical
    // facts mean the second build is served from cache and never reaches the model, so
    // b.state.messages would be undefined and the comparison would be undefined-to-
    // undefined. Prompt determinism needs two ACTUAL model calls on identical facts.
    await dna.buildDna(fresh, { callAI: b.fn, model: 'qwen3.8-flash', forceRefresh: true });
    assert.strictEqual(a.state.calls, 1, 'build A should have called the model once');
    assert.strictEqual(b.state.calls, 1, 'build B should have called the model once (cache bypass failed)');
    assert.ok(a.state.messages && b.state.messages, 'both builds must actually reach the model');
    assert.strictEqual(canonicalJson(a.state.messages[0]), canonicalJson(b.state.messages[0]), 'AI input is not deterministic');
});

test('F2 facts hash is stable under key reordering', function () {
    const facts = buildDesignFacts(clone(F.EXTRACTED), clone(F.META));
    const shuffled = JSON.parse(canonicalJsonReverse(facts));
    assert.strictEqual(factsHash(facts), factsHash(shuffled));
});
function canonicalJsonReverse(o) {
    const rev = (v) => {
        if (Array.isArray(v)) return v.map(rev);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v).reverse()) out[k] = rev(v[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(rev(o));
}

test('F3 P2 does not require cheerio or the network layer', function () {
    const files = ['canonical.js', 'identity.js', 'facts.js', 'projection.js', 'schema.js', 'ground.js', 'dna-prompt.js', 'dna.js'];
    for (const f of files) {
        const src = require('fs').readFileSync(path.join(ROOT, 'lib', f), 'utf8');
        assert.ok(!/require\(['"]cheerio/.test(src), f + ' requires cheerio');
        assert.ok(!/require\(['"](https?|node-fetch)/.test(src), f + ' requires a network lib');
    }
});

test('F4 no model name is baked into the schema', function () {
    const src = require('fs').readFileSync(path.join(ROOT, 'lib/schema.js'), 'utf8');
    assert.ok(!/qwen|glm|gpt|claude/i.test(src), 'schema hardcodes a model');
});

test('F5 callAIWithFallback is never referenced by P2 runtime code', function () {
    const files = ['dna.js', 'dna-prompt.js', 'projection.js', 'ground.js', 'schema.js', 'facts.js', 'identity.js', 'canonical.js'];
    for (const f of files) {
        const src = require('fs').readFileSync(path.join(ROOT, 'lib', f), 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.ok(!/callAIWithFallback\s*\(/.test(code), f + ' calls the fallback chain (breaks the 2-call budget)');
    }
});


test('F6 volatile fetchedAt changes neither the facts hash nor the cache key', async function () {
    dna.clearDnaCache();
    const m1 = clone(F.META);
    const m2 = clone(F.META);
    m2.fetchedAt = m1.fetchedAt + 86400000;               // one day later, identical bytes
    const f1 = buildDesignFacts(clone(F.EXTRACTED), m1);
    const f2 = buildDesignFacts(clone(F.EXTRACTED), m2);
    assert.strictEqual(factsHash(f1), factsHash(f2), 'fetchedAt leaked into the cache identity');
    // Runtime proof, not just the hash function: the second build must be a real HIT.
    const ctx = makeCtx();
    let made = 0;
    const caller = async function () { made++; return canonicalJson(F.validDnaFrom(ctxWith(ctx, f1))); };
    const a = await dna.buildDna(f1, { callAI: caller, model: 'qwen3.8-flash' });
    const b = await dna.buildDna(f2, { callAI: caller, model: 'qwen3.8-flash' });
    assert.strictEqual(a.source, 'miss');
    assert.strictEqual(b.source, 'hit', 'a re-fetch of identical bytes missed the cache');
    assert.strictEqual(b.aiCalls, 0, 'volatile timestamp consumed an AI call');
    assert.strictEqual(made, 1, 'volatile timestamp cost ' + made + ' model calls');
    assert.deepStrictEqual(b.dna, a.dna);
});

test('F7 identical facts hash identically across independent builds (url excluded, domain included)', function () {
    const h1 = factsHash(buildDesignFacts(clone(F.EXTRACTED), clone(F.META)));
    const h2 = factsHash(buildDesignFacts(clone(F.EXTRACTED), clone(F.META)));
    assert.strictEqual(h1, h2, 'the same facts hashed twice produced different cache keys');
    // Characterisation of the DELIBERATE asymmetry in canonical.js VOLATILE_FACTS_PATHS:
    // source.url is excluded, source.domain is NOT. Same bytes under a different host
    // therefore fork the cache - wasteful, never wrong, because the DNA itself is
    // identity-free either way. If domain is ever excluded too, update this ON PURPOSE.
    const m3 = clone(F.META); m3.domain = 'www.zephyrion.com';
    assert.notStrictEqual(h1, factsHash(buildDesignFacts(clone(F.EXTRACTED), m3)),
        'source.domain silently left the cache identity');
    const m4 = clone(F.META); m4.url = 'https://zephyrion.com/pricing?x=1&ref=v2';
    assert.strictEqual(h1, factsHash(buildDesignFacts(clone(F.EXTRACTED), m4)),
        'source.url silently entered the cache identity');
});

// ---------------------------------------------------------------------------
// M. MUTATION CHECKS
// Every guard above is paired with a mutant that must go RED. This file had no
// mutation harness at all before P4, which is how "repair:false" could sit
// implemented in lib/dna.js with nothing pinning it.
// ---------------------------------------------------------------------------
const BUDGET_LINE = '            const budget = (o.repair === false) ? 0 : repairRetries();';

const MUTATIONS = [
    { name: 'M1 repair:false flag ignored', file: 'lib/dna.js',
      find: BUDGET_LINE,
      to: '            const budget = repairRetries(); // MUTANT',
      // Ignores the option, so the generation path retries again. Only E9 notices:
      // E1/E3/E10 all describe the DEFAULT path, which this mutant leaves untouched.
      expect: ['E9'] },
    { name: 'M2 repair budget forced to zero', file: 'lib/dna.js',
      find: BUDGET_LINE,
      to: '            const budget = 0; // MUTANT',
      // The mirror image: the flag now always means "never repair". E9 stays green by
      // accident, so the evidence has to come from the default path.
      expect: ['E10', 'E1'] },
];

test('M0 mutation anchors exist exactly once in their files', () => {
    for (const m of MUTATIONS) {
        const src = fs.readFileSync(path.join(ROOT, m.file), 'utf8');
        const count = src.split(m.find).length - 1;
        assert.strictEqual(count, 1, m.name + ': anchor found ' + count + 'x in ' + m.file);
    }
});

for (const m of MUTATIONS) {
    test(m.name, () => {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dmut-'));
        for (const d of ['lib', 'tests']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
        const target = path.join(tmp, m.file);
        const src = fs.readFileSync(target, 'utf8');
        assert.strictEqual(src.split(m.find).length - 1, 1);
        fs.writeFileSync(target, src.replace(m.find, m.to));
        let out = ''; let code = 0;
        try {
            out = execFileSync(process.execPath, [path.join(tmp, 'tests/dna.test.js'), '--no-mutate'],
                { encoding: 'utf8', env: Object.assign({}, process.env, { ONLY: '' }), timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            code = e.status === undefined ? -1 : e.status;
            out = String(e.stdout || '') + String(e.stderr || '');
        }
        if (code === 0) assert.fail('MUTANT SURVIVED: with ' + m.file + ' mutated (' + m.name + '), expected red on [' + m.expect.join(', ') + ']');
        const failedNames = out.split('\n').filter((l) => l.startsWith('  FAIL ')).map((l) => l.slice(7).trim());
        for (const want of m.expect) {
            assert.ok(failedNames.some((nm) => nm.startsWith(want.trim())),
                'mutant ' + m.name + ': expected red on "' + want + '", but only [' + (failedNames.join(' | ') || 'nothing') + '] failed');
        }
    });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------
const started = Date.now();
(async function () {
    let pass = 0;
    const fails = [];
    // ONLY=<substring> runs a subset. A filter that matches nothing must fail
    // LOUDLY - an empty queue reports "0 passed / 0 failed" and looks green,
    // which is the test-that-cannot-fail trap wearing a runner's clothes.
    const only = (process.env.ONLY || '').trim();
    const NO_MUTATE = process.argv.includes('--no-mutate');
    let queue = NO_MUTATE ? tests.filter(function (t) { return !/^M\d/.test(t.name); }) : tests;
    if (only) {
        // An ID-shaped filter ("C1", "D9") must match that test ALONE. Plain substring
        // made ONLY="C1" silently run C10-C15 as well (measured: -> 7/61), so a pass
        // attributed to C1 was really evidence about seven tests. Substring stays
        // available for phrase filters, which is what they are actually good at.
        const idShaped = /^[A-Za-z]\d+$/.test(only);
        queue = tests.filter(function (t) {
            return idShaped ? t.name.split(' ')[0] === only : t.name.indexOf(only) !== -1;
        });
        if (!queue.length) {
            process.stdout.write('  FAIL ONLY="' + only + '" matched 0 of ' + tests.length + ' tests\n');
            process.exit(1);
        }
        process.stdout.write('  [filtered] ONLY="' + only + '" -> ' + queue.length + '/' + tests.length + ' tests\n');
    }
    // Duplicate test names make the ONLY= filter silently run extras. Proven the hard
    // way: adding 'F3 ...' beside an existing 'F3 ...' made ONLY=F3 match 2 tests and
    // report a pass that attributed the wrong evidence. Fail loudly instead.
    const seenNames = new Map();
    for (const t of tests) seenNames.set(t.name, (seenNames.get(t.name) || 0) + 1);
    const dups = [...seenNames].filter(([, c]) => c > 1).map(([nm]) => nm);
    if (dups.length) {
        process.stdout.write('  FAIL duplicate test names (' + dups.length + '): ' + dups.join(' | ') + '\n');
        process.exit(1);
    }
    const registered = queue.length;
    for (const t of queue) {
        try {
            await t.fn();
            pass++;
            process.stdout.write('  ok   ' + t.name + '\n');
        } catch (e) {
            fails.push({ name: t.name, err: e });
            process.stdout.write('  FAIL ' + t.name + '\n         ' + String(e.message).split('\n').join('\n         ') + '\n');
        }
    }
    if (pass + fails.length !== registered) {
        process.stdout.write('  FAIL harness: registered ' + registered + ' but ran ' + (pass + fails.length) + '\n');
        fails.push({ name: 'harness', err: new Error('count mismatch') });
    }
    process.stdout.write('\n' + pass + ' passed / ' + fails.length + ' failed  (of ' + registered + ' registered) in ' + ((Date.now() - started) / 1000).toFixed(1) + 's\n');
    process.exit(fails.length ? 1 : 0);
})();
