// tests/content.test.js — P4: AI Call #2. DesignDNA + UserBrand -> ContentSpec.
//
// Harness rules inherited from this project's recorded failures: executed-count
// asserted, ONLY= filter must match or dies, duplicate names die, no pipes,
// nonzero exit on any failure. The M-series mutates lib in a child process and
// requires the targeted tests to go RED — a green guard that cannot fail is
// theatre (frontend_harness_counts_registrations, source_grep_guard class).
//
// Every buildContent test injects opts.callAI: ZERO live network calls happen
// in this file. The live-probe stage is separately gated by the user.
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { buildDesignFacts } = require(path.join(ROOT, 'lib/facts.js'));
const { buildProjection } = require(path.join(ROOT, 'lib/projection.js'));
const { factsHash, sha256, canonicalJson } = require(path.join(ROOT, 'lib/canonical.js'));
const { buildForbidden, makeScanner } = require(path.join(ROOT, 'lib/identity.js'));
const F = require(path.join(__dirname, 'fixtures/dna-zephyrion.js'));
const C = require(path.join(ROOT, 'lib/content.js'));
const { buildMessages, dnaToText, userPrompt } = require(path.join(ROOT, 'lib/content-prompt.js'));
const { validateUserBrand, requireDescription } = require(path.join(ROOT, 'lib/userbrand.js'));
const { validateContent } = require(path.join(ROOT, 'lib/compiler/content-schema.js'));
const { compileSite } = require(path.join(ROOT, 'lib/compiler/index.js'));

const clone = (o) => JSON.parse(JSON.stringify(o));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

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

function brandFixture() {
    return {
        name: 'KiteStack',
        tagline: 'Ship software from intent',
        description: 'KiteStack turns written intent into deployed software. Teams describe a feature and get a reviewed pull request with tests. It connects to GitHub and runs checks in its own sandbox.',
        logo: { mode: 'generated' },
    };
}
function contentFixture() {
    return {
        schema: 'contentspec/1',
        brand: { name: 'KiteStack', tagline: 'Ship software from intent' },
        nav: {
            items: [{ label: 'Features', href: '#features' }, { label: 'How it works', href: '#how' }],
            cta: { label: 'Get started', href: '#start' },
        },
        hero: {
            eyebrow: 'For product teams',
            heading: 'Describe the feature. Review the pull request.',
            sub: 'KiteStack reads your intent, writes the code, and hands you a tested diff.',
            ctas: [{ label: 'Start free', kind: 'primary', href: '#start' }],
        },
        sections: [
            { id: '#features', type: 'FEATURE_GRID', title: 'Built for review', items: [
                { title: 'Typed diffs', body: 'Every change arrives as a pull request with tests.' },
                { title: 'Sandboxed', body: 'Builds run isolated from your production accounts.' }] },
            { id: '#how', type: 'FEATURE_LIST', title: 'How it works', items: [
                { title: 'Describe', body: 'Write the behavior you want in plain language.' },
                { title: 'Review', body: 'Read the diff, comment, merge when it is right.' }] },
            { id: '#start', type: 'CTA', title: 'Ready?', items: [
                { heading: 'Start today', body: 'Free while KiteStack is in beta.' }] },
        ],
        footer: { blurb: 'The shortest path from intent to merged code.' },
    };
}
// injected caller: records every call, returns canned text
function fakeCaller(replies) {
    const state = { calls: 0, last: null };
    const fn = async (messages) => {
        const i = state.calls; state.calls++; state.last = messages;
        const r = typeof replies === 'function' ? replies(i) : replies[i];
        if (r instanceof Error) throw r;
        return typeof r === 'string' ? r : JSON.stringify(r);
    };
    return { fn, state };
}
const run = (dna, brand, extra) => C.buildContent(dna || CTX.dna, brand || brandFixture(), Object.assign({ scan: CTX.scan, model: 'test-model' }, extra || {}));
const okRun = async (extra) => { const fc = fakeCaller([contentFixture()]); const res = await run(null, null, Object.assign({ callAI: fc.fn }, extra || {})); return { res, fc }; }

// ---- A: gates ----------------------------------------------------------------
test('A1 non-designdna/1 rejected', () => assert.rejects(run({ schema: 'x' }), /designdna\/1/));
test('A2 DNA with non-null reference identity refused', () => {
    const d = clone(CTX.dna); d.identity.referenceName = 'Zephyrion';
    return assert.rejects(run(d), (e) => e.name === 'ContentIdentityError' && /structural/.test((e.leaks || []).join(',')));
});
test('A3 UserBrand shape enforced', () => assert.rejects(run(null, { name: '', description: 'long enough description here' }), (e) => e.name === 'ContentBrandError'));
test('A4 missing description refused pre-call, not mid-pipeline', () => {
    const fc = fakeCaller([contentFixture()]);
    const b = brandFixture(); delete b.description;
    return run(null, b, { callAI: fc.fn }).then(
        () => assert.fail('should throw'),
        (e) => { assert.strictEqual(e.name, 'ContentBrandError'); assert.strictEqual(fc.state.calls, 0, 'must not spend a call'); assert.ok(/10\+ characters/.test(e.message)); }
    );
});
test('A5 requireScan without matcher dies loudly', () => assert.rejects(
    C.buildContent(CTX.dna, brandFixture(), { callAI: fakeCaller([contentFixture()]).fn, requireScan: true, model: 'test-model' }),
    /no identity matcher available/));
test('A6 valid gates pass and identity meta reports p4', async () => {
    const { res } = await okRun();
    assert.strictEqual(res.identity.by, 'p4'); assert.strictEqual(res.identity.scanned, true);
});
test('A7 designFacts accepted as scanner source', async () => {
    const fc = fakeCaller([contentFixture()]);
    const res = await C.buildContent(CTX.dna, brandFixture(), { designFacts: CTX.facts, callAI: fc.fn, model: 'test-model' });
    assert.strictEqual(res.identity.by, 'p4');
});
test('A8 validateUserBrand unit: max 64 name', () => {
    assert.strictEqual(validateUserBrand({ name: 'x'.repeat(65) }).ok, false);
    assert.strictEqual(validateUserBrand({ name: 'x'.repeat(64) }).ok, true);
    assert.strictEqual(validateUserBrand('string').ok, false);
    assert.strictEqual(validateUserBrand({ name: 'ok', logo: { mode: 'weird' } }).ok, false);
});
test('A9 requireDescription boundary', () => {
    assert.strictEqual(requireDescription({ description: '1234567890' }), true);
    assert.strictEqual(requireDescription({ description: '123456789' }), false);
    assert.strictEqual(requireDescription({ description: '   1234567890   ' }), true);
});

// ---- B: prompt hygiene --------------------------------------------------------
test('B1 deterministic bytes: same inputs -> identical messages', () => {
    const a = buildMessages(brandFixture(), CTX.dna); const b = buildMessages(brandFixture(), CTX.dna);
    assert.strictEqual(canonicalJson(a), canonicalJson(b));
    assert.strictEqual(sha256(canonicalJson(a)), sha256(canonicalJson(b)));
});
test('B2 user prompt carries the user  own name, tagline, description', () => {
    const u = buildMessages(brandFixture(), CTX.dna)[1].content;
    for (const s of ['KiteStack', 'Ship software from intent', 'reviewed pull request']) assert.ok(u.includes(s), s);
});
test('B3 wire contains NO reference identity', () => {
    const wire = canonicalJson(buildMessages(brandFixture(), CTX.dna));
    for (const t of ['zephyrion', 'Zephyrion', 'zephyrion.com']) assert.ok(!wire.includes(t), 'leaked: ' + t);
});
test('B4 prompt carries NO numeric design facts (real + injected)', () => {
    // (a) REAL: the fixture DNA palette.roles DO carry hex values (#3d5afe ...) —
    // dnaToText drops roles entirely, so 'roles hex not in wire' is a live property.
    // (b) INJECTED: distinctive sentinels into non-whitelisted fields. Sentinels are
    // chosen so no digit string collides with TARGET_SHAPE prose (\'1-8 items\' would
    // false-positive on a bare \'8\'), and prose fields are left alone (a rhythm
    // STRING may legally say \'4px grid\' — prose is the prompt\'s whole point).
    const realHexes = (CTX.dna.palette.roles || []).map((r) => r.value).filter(Boolean);
    assert.ok(realHexes.length >= 3, 'fixture DNA lost its hex roles; B4 would pass vacuously');
    const d = clone(CTX.dna);
    d.palette.hexes = ['#ab12cd', '#9900ee'];
    d.spacing.px = [719, 311];
    d.motion.durations = [6173];
    d.radius.px = 911;
    d.magicNumber = 1234567;
    const u = canonicalJson(buildMessages(brandFixture(), d));
    for (const h of realHexes) assert.ok(!u.includes(h), 'role hex rode into prompt: ' + h);
    for (const v of ['#ab12cd', '#9900ee', '719', '311', '6173', '911', '1234567'])
        assert.ok(!u.includes(v), 'fact rode into prompt: ' + v);
});
test('B5 system prompt states the honesty rules', () => {
    const s = buildMessages(brandFixture(), CTX.dna)[0].content;
    for (const phrase of ['invented numbers', 'in-page anchors', 'plain text']) assert.ok(s.toLowerCase().includes(phrase), phrase);
});
test('B6 dnaToText keeps prose, drops objects/numbers', () => {
    const d = clone(CTX.dna); d.spacing = Object.assign({}, d.spacing, { px: [8, 16, 24] });
    const t = dnaToText(d);
    assert.ok(!JSON.stringify(t).includes('[8,16,24]'));
    assert.strictEqual(typeof t.voice.tone, 'string');
});
test('B7 TARGET_SHAPE validates as a shape hint source (B7 keeps it honest)', () => {
    const p = require(path.join(ROOT, 'lib/content-prompt.js'));
    assert.ok(p.TARGET_SHAPE.includes('contentspec/1'));
    assert.ok(p.TARGET_SHAPE.includes('FEATURE_GRID'));
});
test('B9 numeric values under WHITELISTED keys are dropped', () => {
    // The sentinel must live where a numeric branch COULD fire: an allowed key
    // (voice.tone, spacing.rhythm). Unlisted fields (B8) are a different, already
    // pinned property — first draft of this test injected only unlisted keys and
    // survived the M6 mutant for that reason.
    const d = clone(CTX.dna);
    d.voice = Object.assign({}, d.voice, { tone: 1234567 });
    d.spacing = Object.assign({}, d.spacing, { rhythm: 9876543 });
    const u = canonicalJson(buildMessages(brandFixture(), d));
    assert.ok(!u.includes('1234567'), 'whitelisted numeric tone rode into prompt');
    assert.ok(!u.includes('9876543'), 'whitelisted numeric rhythm rode into prompt');
});
test('B8 unknown future DNA field cannot ride the fixed key list', () => {
    const d = clone(CTX.dna); d.smuggled = { secret: 'zephyrion.com' }; d.extra = 'zephyrion';
    assert.ok(!JSON.stringify(dnaToText(d)).includes('zephyrion'));
});

// ---- C: parsing ---------------------------------------------------------------
test('C1 fenced json parsed', async () => {
    const fc = fakeCaller(['```json\n' + JSON.stringify(contentFixture()) + '\n```']);
    const res = await run(null, null, { callAI: fc.fn }); assert.strictEqual(res.content.brand.name, 'KiteStack');
});
test('C2 prose-wrapped json parsed', async () => {
    const fc = fakeCaller(['Here is the object:\n' + JSON.stringify(contentFixture()) + '\nEnjoy!']);
    const res = await run(null, null, { callAI: fc.fn }); assert.strictEqual(res.content.schema, 'contentspec/1');
});
test('C3 empty answer -> ContentSpecError, 1 call', async () => {
    const fc = fakeCaller(['']);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentSpecError' && fc.state.calls === 1);
});
test('C4 garbage (no braces) -> ContentSpecError', async () => {
    const fc = fakeCaller(['I cannot help with that.']);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentSpecError');
});
test('C5 truncated json -> ContentSpecError, never partial accept', async () => {
    const s = JSON.stringify(contentFixture());
    const fc = fakeCaller([s.slice(0, s.length - 40)]);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentSpecError');
});

// ---- D: validation ------------------------------------------------------------
const expectReject = (mut, re) => async () => {
    const c = contentFixture(); mut(c);
    const fc = fakeCaller([c]);
    let err = null;
    try { await run(null, null, { callAI: fc.fn }); } catch (e) { err = e; }
    assert.ok(err, 'expected ContentSpecError, resolved instead');
    assert.strictEqual(err.name, 'ContentSpecError');
    assert.ok(re.test((err.errors || []).join('\n')), 'errors: ' + JSON.stringify(err.errors));
};
test('D1 missing hero.sub rejected', expectReject((c) => { delete c.hero.sub; }, /sub/));
test('D2 unknown key rejected', expectReject((c) => { c.extracss = 'x'; }, /extracss|unknown/i));
test('D3 external URL href rejected', expectReject((c) => { c.nav.items[0].href = 'https://elsewhere.example/x'; }, /anchor/));
test('D4 javascript: href rejected', expectReject((c) => { c.nav.items[0].href = 'javascript:alert(1)'; }, /anchor/));
test('D5 9 sections rejected', expectReject((c) => { while (c.sections.length < 9) c.sections.push({ id: '#s' + c.sections.length, type: 'TEXT', title: 'More', items: [{ body: 'Plain words.' }] }); }, /sections/));
test('D6 STATS with wrong item shape rejected', expectReject((c) => { c.sections[1] = { id: '#how', type: 'STATS', title: 'Numbers', items: [{ title: 'oops', body: 'wrong shape' }] }; }, /value|label/));
test('D7 duplicate nav hrefs rejected', expectReject((c) => { c.nav.items[1].href = '#features'; }, /unique|duplicate|nav/));
test('D8 oversized name rejected', expectReject((c) => { c.hero.heading = 'x'.repeat(91); }, /heading|max/));
test('D9 brand echo mismatch rejected', expectReject((c) => { c.brand.name = 'Kite-Stack Pro'; }, /exactly/));
test('D10 wrong schema version rejected', expectReject((c) => { c.schema = 'contentspec/2'; }, /contentspec\/1/));
test('D11 filler lorem rejected', expectReject((c) => { c.hero.heading = 'Lorem ipsum dolor sit amet'; }, /placeholder/));
test('D12 filler feature-one rejected', expectReject((c) => { c.sections[0].items[0].title = 'Feature one'; }, /placeholder/));
test('D13 dead anchor rejected', expectReject((c) => { c.nav.items[0].href = '#ghost'; }, /dead anchor/));
test('D14 #top nav link allowed without a #top section', async () => {
    const c = contentFixture(); c.nav.items[0].href = '#top';
    const fc = fakeCaller([c]);
    const res = await run(null, null, { callAI: fc.fn });
    assert.strictEqual(res.content.nav.items[0].href, '#top');
});
test('D15 postValidate clean fixture -> no errors', () => assert.deepStrictEqual(C.postValidate(contentFixture(), brandFixture()), []));
test('D16 validateContent parity: fixture valid standalone', () => assert.strictEqual(validateContent(contentFixture()).ok, true));

// ---- E: identity firewall -------------------------------------------------------
test('E1 generated leak -> ContentIdentityError with token named, zero writes', async () => {
    const c = contentFixture(); c.hero.sub = 'Like Zephyrion, but for teams.';
    const fc = fakeCaller([c]);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentIdentityError' && /zephyrion/.test(e.leaks.join(',')));
});
test('E2 userbrand with reference token refused BEFORE the call', async () => {
    const fc = fakeCaller([contentFixture()]);
    const b = brandFixture(); b.name = 'Zephyrion Fans Unite';
    await assert.rejects(run(null, b, { callAI: fc.fn }), (e) => e.name === 'ContentIdentityError' && /UserBrand itself/.test(e.message));
    assert.strictEqual(fc.state.calls, 0);
});
test('E3 near-collision passes untouched (guard not over-strict)', async () => {
    const fc = fakeCaller([contentFixture()]);
    const b = brandFixture(); b.name = 'Zephyr Analytics'; b.description = 'Zephyr Analytics turns intent into pull requests for data teams.';
    const c = contentFixture(); c.brand.name = 'Zephyr Analytics';
    const res = await run(null, b, { callAI: fakeCaller([c]).fn });
    assert.strictEqual(res.content.brand.name, 'Zephyr Analytics');
});
test('E4 leak in copy body (deep) also caught', async () => {
    const c = contentFixture(); c.sections[1].items[1].body = 'zephyrion.com does this too';
    await assert.rejects(run(null, null, { callAI: fakeCaller([c]).fn }), (e) => e.name === 'ContentIdentityError');
});
test('E5 cache poisoned after scan -> read path re-throws (revalidate on read)', async () => {
    const brand = brandFixture();
    const fc = fakeCaller([contentFixture()]);
    const r1 = await run(null, brand, { callAI: fc.fn });
    assert.strictEqual(r1.source, 'miss');
    // seed an ENTRY (bypasses buildContent's pre-scan by design: seeding stands in
    // for an entry written before a stricter rule existed)
    C._seedContentCache(brand, CTX.dna, (function () { const c = contentFixture(); c.footer.blurb = 'Powered by Zephyrion'; return c; })(), 'test-model');
    await assert.rejects(run(null, brand, { callAI: fakeCaller([contentFixture()]).fn }), (e) => e.name === 'ContentIdentityError');
});

// ---- F: budget ------------------------------------------------------------------
test('F1 success costs exactly 1 call', async () => { const { res, fc } = await okRun(); assert.strictEqual(res.aiCalls, 1); assert.strictEqual(fc.state.calls, 1); });
test('F2 invalid answer costs exactly 1 call by default (no repair spend)', async () => {
    const bad = contentFixture(); delete bad.footer;
    const fc = fakeCaller([bad, bad]);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentSpecError');
    assert.strictEqual(fc.state.calls, 1);
});
test('F3 opts.repair=1 retries and reports aiCalls 2', async () => {
    const bad = contentFixture(); delete bad.footer;
    const fc = fakeCaller([bad, contentFixture()]);
    const res = await run(null, null, { callAI: fc.fn, repair: 1 });
    assert.strictEqual(res.aiCalls, 2); assert.strictEqual(fc.state.calls, 2); assert.strictEqual(res.source, 'miss');
});
test('F4 CONTENT_REPAIR_RETRIES env read at call time', async () => {
    const prev = process.env.CONTENT_REPAIR_RETRIES;
    process.env.CONTENT_REPAIR_RETRIES = '1';
    try {
        const bad = contentFixture(); delete bad.footer;
        const fc = fakeCaller([bad, contentFixture()]);
        const res = await run(null, null, { callAI: fc.fn });
        assert.strictEqual(res.aiCalls, 2);
    } finally { if (prev === undefined) delete process.env.CONTENT_REPAIR_RETRIES; else process.env.CONTENT_REPAIR_RETRIES = prev; }
});
test('F5 provider error passes through untouched, no retry', async () => {
    const boom = new Error('rate limited');
    const fc = fakeCaller([boom]);
    await assert.rejects(run(null, null, { callAI: fc.fn }), /rate limited/);
    assert.strictEqual(fc.state.calls, 1);
});
test('F6 in-flight coalescing: 2nd caller shares, aiCalls 0', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const fc = fakeCaller([contentFixture()]);
    const orig = fc.fn;
    const slow = async (m, o) => { await gate; return orig(m, o); };
    const p1 = C.buildContent(CTX.dna, brandFixture(), { callAI: slow, model: 'test-model', scan: CTX.scan });
    const p2 = C.buildContent(CTX.dna, brandFixture(), { callAI: fakeCaller([contentFixture()]).fn, model: 'test-model', scan: CTX.scan });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.aiCalls, 1); assert.strictEqual(r2.aiCalls, 0); assert.strictEqual(r2.source, 'shared');
});
test('F7 repairMessages: keeps both originals, adds rule text', () => {
    const msgs = buildMessages(brandFixture(), CTX.dna);
    const bad = contentFixture(); delete bad.footer;
    const r = C.repairMessages(msgs, bad, ['$.footer: required']);
    assert.strictEqual(r.length, 3);
    assert.strictEqual(r[0], msgs[0]); assert.strictEqual(r[1], msgs[1]);
    assert.ok(r[2].content.includes('$.footer: required'));
    assert.ok(r[2].content.includes(canonicalJson(bad)));
});

// ---- G: cache -------------------------------------------------------------------
test('G1 hit costs 0 calls, byte-identical content', async () => {
    const fc = fakeCaller([contentFixture()]);
    const r1 = await run(null, null, { callAI: fc.fn });
    const r2 = await run(null, null, { callAI: fakeCaller([contentFixture()]).fn });
    assert.strictEqual(r1.source, 'miss'); assert.strictEqual(r2.source, 'hit'); assert.strictEqual(r2.aiCalls, 0);
    assert.strictEqual(canonicalJson(r1.content), canonicalJson(r2.content));
});
test('G2 key order of userBrand irrelevant', () => {
    const a = brandFixture(); const b = { description: a.description, logo: a.logo, tagline: a.tagline, name: a.name };
    assert.strictEqual(C.contentCacheKey(a, CTX.dna, 'm'), C.contentCacheKey(b, CTX.dna, 'm'));
});
test('G3 description change = new entry', () => {
    const a = brandFixture(); const b = brandFixture(); b.description += ' Also self-hosted.';
    assert.notStrictEqual(C.contentCacheKey(a, CTX.dna, 'm'), C.contentCacheKey(b, CTX.dna, 'm'));
});
test('G4 prompt-visible dna change = new entry', () => {
    const d2 = clone(CTX.dna); d2.voice = Object.assign({}, d2.voice, { tone: 'playful' });
    assert.notStrictEqual(C.contentCacheKey(brandFixture(), CTX.dna, 'm'), C.contentCacheKey(brandFixture(), d2, 'm'));
});
test('G4b factsHash-only change keeps the key (documented consequence of prompt-hash keys)', () => {
    // The cache key is the PROMPT, not the facts. If only the hash changes, the
    // interpretive text is identical and the same copy is still the right answer.
    // Pinned here so nobody "fixes" this into a factsHash key that fragments cache.
    const d2 = clone(CTX.dna); d2.factsHash = 'sha256:' + '0'.repeat(64);
    assert.strictEqual(C.contentCacheKey(brandFixture(), CTX.dna, 'm'), C.contentCacheKey(brandFixture(), d2, 'm'));
});
test('G5 model change = new entry (no cross-model poisoning)', () => {
    assert.notStrictEqual(C.contentCacheKey(brandFixture(), CTX.dna, 'm1'), C.contentCacheKey(brandFixture(), CTX.dna, 'm2'));
});
test('G6 expired entry deleted on read, refetched', async () => {
    const prevTtl = C._setContentTtlMs(0);
    try {
        const fc1 = fakeCaller([contentFixture()]);
        await run(null, null, { callAI: fc1.fn });
        const fc2 = fakeCaller([contentFixture()]);
        const r = await run(null, null, { callAI: fc2.fn });
        assert.strictEqual(r.source, 'miss'); assert.strictEqual(fc2.state.calls, 1);
    } finally { C._setContentTtlMs(prevTtl); }
});
test('G7 forceRefresh bypasses store', async () => {
    await okRun();
    const fc = fakeCaller([contentFixture()]);
    const r = await run(null, null, { callAI: fc.fn, forceRefresh: true });
    assert.strictEqual(r.source, 'miss'); assert.strictEqual(fc.state.calls, 1);
});
test('G8 seeded entry hits with source hit', () => {
    const brand = brandFixture();
    C._seedContentCache(brand, CTX.dna, contentFixture(), 'test-model');
    return run(null, brand, { callAI: fakeCaller([contentFixture()]).fn }).then((r) => assert.strictEqual(r.source, 'hit'));
});
test('G9 clearContentCache empties', async () => {
    await okRun();
    C.clearContentCache();
    assert.strictEqual(C.contentCacheStats().entries, 0);
    const r = await run(null, null, { callAI: fakeCaller([contentFixture()]).fn });
    assert.strictEqual(r.source, 'miss');
});

// ---- H: compiler compatibility ----------------------------------------------------
test('H1 buildContent output feeds compileSite untouched -> site/1', async () => {
    const { res } = await okRun();
    const site = compileSite(CTX.dna, res.content, brandFixture(), { scan: CTX.scan });
    assert.strictEqual(site.schema, 'site/1');
    assert.ok(site.html.includes('Describe the feature. Review the pull request.'));
    assert.ok(site.html.includes('KiteStack'));
});
test('H2 leaked content cannot sneak past either stage (belt & braces)', async () => {
    const c = contentFixture(); c.sections[0].title = 'Zephyrion-grade output';
    const fc = fakeCaller([c]);
    await assert.rejects(run(null, null, { callAI: fc.fn }), (e) => e.name === 'ContentIdentityError');
});
test('H3 result meta carries factsHash + timings', async () => {
    const { res } = await okRun();
    assert.strictEqual(res.factsHash, CTX.dna.factsHash);
    assert.strictEqual(typeof res.timings.aiMs, 'number');
    assert.strictEqual(res.model, 'test-model');
});

// ---- Z: harness ---------------------------------------------------------------------
test('Z1 exports present and typed', () => {
    for (const fn of ['buildContent', 'buildMessages', 'parseModelJson', 'postValidate', 'findFiller', 'findDeadAnchors', 'contentCacheKey', 'clearContentCache', '_seedContentCache', 'repairMessages'])
        assert.strictEqual(typeof C[fn], 'function', fn);
});

// ---- M: mutations (child process, mutated COPY; source never touched) ----------
const MUTATIONS = [
    { name: 'M1 validateContent removed from postValidate', file: 'lib/content.js',
      find: '    const v = validateContent(raw);',
      to: "    const v = { ok: true, errors: [] }; // MUTANT",
      // D3/D4 DELIBERATELY NOT listed: measured, they stay green under this mutant
      // because findDeadAnchors independently rejects external hrefs. Defense in
      // depth — one layer removed, the other still holds. Pinned so a future
      // 'simplification' of the anchor layer must answer for it.
      expect: ['D1', 'D2', 'D5', 'D10'] },
    { name: 'M2 output identity scan removed', file: 'lib/content.js',
      find: 'const leaks = scan ? scan(JSON.stringify(content)) : null;',
      to: 'const leaks = null; // MUTANT',
      expect: ['E1', 'E4', 'E5'] },
    { name: 'M3 pre-call brand scan removed', file: 'lib/content.js',
      find: '        const pre = scan(JSON.stringify(userBrand));',
      to: '        const pre = null; // MUTANT',
      expect: ['E2'] },
    { name: 'M4 repair-default flipped to retry-always', file: 'lib/content.js',
      find: "const budget = (o.repair === false) ? 0 : (typeof o.repair === 'number' ? o.repair : repairRetries());",
      to: 'const budget = 5; // MUTANT',
      expect: ['F2'] },
    { name: 'M5 cache key collapsed to constant', file: 'lib/content.js',
      find: "return 'content|' + sha256(canonicalJson(messages)) + '|' + (model || process.env.OPENAI_MODEL || 'qwen3.8-flash');",
      to: "return 'content|fixed'; // MUTANT",
      expect: ['G3', 'G5'] },
    { name: 'M6 dnaToText grows a numeric branch', file: 'lib/content-prompt.js',
      find: '            // numbers are dropped by construction: this function has no numeric branch',
      to: "            else if (typeof v === 'number') dst[k] = v; // MUTANT",
      expect: ['B9'] },
    { name: 'M7 dead-anchor set loses #top', file: 'lib/content.js',
      find: "const ids = new Set(['#top']);",
      to: "const ids = new Set(); // MUTANT",
      expect: ['D14'] },
    { name: 'M8 prompt wire smuggles reference domain', file: 'lib/content-prompt.js',
      find: "const { canonicalJson } = require('./canonical.js');",
      to: "const canonicalJson = (o) => require('./canonical.js').canonicalJson(Object.assign({}, o, { leak: 'zephyrion.com' })); // MUTANT",
      expect: ['B3'] },
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
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cmut-'));
        for (const d of ['lib', 'tests']) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true });
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
        const target = path.join(tmp, m.file);
        const src = fs.readFileSync(target, 'utf8');
        assert.strictEqual(src.split(m.find).length - 1, 1);
        fs.writeFileSync(target, src.replace(m.find, m.to));
        let out = ''; let code = 0;
        try {
            out = execFileSync(process.execPath, [path.join(tmp, 'tests/content.test.js'), '--no-mutate'],
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

// ---- runner (same conventions as dna.test.js / compiler.test.js) ----------------
const started = Date.now();
const NO_MUTATE = process.argv.includes('--no-mutate');
(async function () {
    let pass = 0;
    const fails = [];
    const only = (process.env.ONLY || '').trim();
    let queue = NO_MUTATE ? tests.filter((t) => !/^M\d/.test(t.name)) : tests;
    if (only) {
        queue = queue.filter((t) => t.name.startsWith(only) || t.name.includes(only));
        if (!queue.length) { process.stdout.write('  FAIL ONLY="' + only + '" matched 0 tests\n'); process.exit(1); }
        process.stdout.write('  [filtered] ONLY="' + only + '" -> ' + queue.length + ' tests\n');
    }
    const seen = new Map();
    for (const t of queue) seen.set(t.name, (seen.get(t.name) || 0) + 1);
    const dups = [...seen].filter(([, n]) => n > 1).map(([nm]) => nm);
    if (dups.length) { process.stdout.write('  FAIL duplicate test names: ' + dups.join(' | ') + '\n'); process.exit(1); }
    const registered = queue.length;
    for (const t of queue) {
        try { C.clearContentCache(); await t.fn(); pass++; process.stdout.write('  ok   ' + t.name + '\n'); }
        catch (e) {
            fails.push({ name: t.name, err: e });
            process.stdout.write('  FAIL ' + t.name + '\n         ' + String(e.message).split('\n').join('\n         ') + '\n');
        }
    }
    if (pass + fails.length !== registered) {
        process.stdout.write('  FAIL harness: registered ' + registered + ', ran ' + (pass + fails.length) + '\n');
        fails.push({ name: 'harness', err: new Error('count mismatch') });
    }
    process.stdout.write('\n' + pass + ' passed / ' + fails.length + ' failed  (of ' + registered + ' registered) in ' + ((Date.now() - started) / 1000).toFixed(1) + 's\n');
    process.exit(fails.length ? 1 : 0);
})();
