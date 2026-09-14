// lib/facts.js — DesignFacts: what we KNOW.
//
// Input is the `extracted` object produced by the pinned uidconstruct pipeline
// (lib/pipeline.js buildAnalysisPrompt). Output is a versioned, status-tagged
// structure. Two rules this file exists to enforce:
//
//  1. ABSENCE IS EXPLICIT. Measured on a real modern site, 6 of the 13 legacy
//     `signals` fields are always empty (cheerio is a parser, not a browser, so
//     inline-style extractors see nothing on a class-based site). An empty array
//     downstream reads as "the site has no colours". Every section therefore
//     carries status: extracted | unavailable | truncated.
//
//  2. FACTS ARE NEVER INVENTED. Values are copied verbatim from extraction.
//     Where extraction gives nothing, the section is 'unavailable' and nothing
//     is substituted - not here, and not by the model later.

const STATUS = { OK: 'extracted', NONE: 'unavailable', PART: 'truncated' };

function arr(v) { return Array.isArray(v) ? v : []; }

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// "#fff" / "ffffff" -> "#ffffff"; anything unparsable -> null (dropped, not guessed)
function normHex(v) {
    let s = String(v).trim().toLowerCase();
    if (!s) return null;
    if (s[0] === '#') s = s.slice(1);
    if (!/^[0-9a-f]{3}$|^[0-9a-f]{4}$|^[0-9a-f]{6}$|^[0-9a-f]{8}$/.test(s)) return null;
    if (s.length === 3 || s.length === 4) s = s.split('').map((c) => c + c).join('');
    if (s.length === 8) s = s.slice(0, 6);
    return '#' + s;
}

function px(v) {
    const s = String(v).trim().toLowerCase();
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(s);
    return m ? num(m[1]) : null;
}

function isColorValue(v) {
    return /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(var\(--[a-z0-9-]+\))/i.test(String(v));
}

function bucketOf(name, value) {
    if (isColorValue(value)) return 'colour';
    if (/^--(font|leading|tracking|letter|text-|heading|body|caption)/i.test(name)) return 'type';
    return 'geometry';
}

function section(status, payload) {
    return Object.assign({ status }, payload);
}

function buildDesignFacts(extracted, meta) {
    const e = extracted || {};
    const m = meta || {};

    // ---- colour / type / geometry from designTokens -------------------------
    // designTokens arrives as text lines: "[color]" header then "  --name: value".
    const colourItems = [];
    const typeItems = [];
    const geometryItems = [];
    const rawTokens = arr(e.designTokens);
    let bucket = null;
    for (const line of rawTokens) {
        const text = String(line);
        const hdr = /^\[(color|geometry|type)\]$/.exec(text.trim());
        if (hdr) { bucket = hdr[1] === 'color' ? 'colour' : hdr[1]; continue; }
        const mm = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(text);
        if (!mm) continue;
        const item = { name: mm[1], rawValue: mm[2], bucket: bucket || bucketOf(mm[1], mm[2]) };
        if (item.bucket === 'colour') { const h = normHex(item.rawValue); if (h) item.value = h; colourItems.push(item); }
        else if (item.bucket === 'type') { item.value = item.rawValue; typeItems.push(item); }
        else { item.value = item.rawValue; if (px(item.rawValue) !== null) item.px = px(item.rawValue); geometryItems.push(item); }
    }

    // ---- fonts --------------------------------------------------------------
    // Kept verbatim here, including brand-bearing family names. Stripping happens
    // in projection, never in facts: facts must remain a faithful record of what
    // extraction saw, or we cannot audit our own sanitisation.
    const families = arr(e.cssFonts).map((f) => ({ raw: String(f) }));

    // ---- breakpoints --------------------------------------------------------
    const bps = arr(e.cssBreakpoints).map((b) => ({ raw: String(b), px: px(b) })).filter((b) => b.px !== null);

    // ---- component rules ----------------------------------------------------
    // Selector carries CSS-module hashes; we keep the string but also record a
    // structural kind derived without the hash, so projection can use kind alone.
    const comps = arr(e.componentRules).map((r) => {
        const s = String(r);
        const sel = /^\s*([^{]+)\{/.exec(s);
        const selector = sel ? sel[1].trim() : null;
        return { selector, css: s, kind: kindOf(selector) };
    });

    // ---- motion -------------------------------------------------------------
    const motions = arr(e.motion).map((line) => {
        const s = String(line);
        const kf = /^@keyframes\s+([A-Za-z0-9_-]+)/.exec(s);
        const md = /^@media\s+([^ ]+)\s*:\s*([^ ]+)/.exec(s);
        const out = { raw: s, kind: kf ? 'keyframes' : md ? 'media' : 'other' };
        if (kf) out.name = kf[1];
        if (md) { out.feature = md[1]; out.value = md[2]; }
        return out;
    });

    // ---- structure: counts only, text deliberately never collected ----------
    // pageOutline is a string of visible copy. It is the single largest identity
    // vector measured (44 occurrences of the brand name in 4,691 chars) and it is
    // also third-party copyrighted text. We do not put it in DesignFacts at all.
    const skel = m.skeleton && typeof m.skeleton === 'object' ? m.skeleton : null;

    // ---- assets -------------------------------------------------------------
    const assets = arr(e.assets).map((a) => {
        const s = String(a);
        const um = /https?:\/\/([^\/\s"']+)/.exec(s);
        const role = /^([a-z-]+):/i.exec(s);
        return { url: s, host: um ? um[1].toLowerCase() : null, role: role ? role[1].toLowerCase() : null };
    }).filter((a) => a.url);

    const statusBlock = {
        degraded: !!m.degraded,
        truncated: !!m.truncated,
        droppedCssLinks: num(m.droppedCssLinks) || 0,
        cssBytes: num(m.cssBytes),
        htmlBytes: num(m.htmlBytes),
        notes: arr(m.notes).map(String).slice(0, 20),
    };

    const facts = {
        schema: 'designfacts/1',
        source: {
            url: m.url || null,
            domain: m.domain || null,
            fetchedAt: num(m.fetchedAt),
            httpStatus: num(m.httpStatus),
        },
        status: statusBlock,
        colour: section(colourItems.length ? STATUS.OK : STATUS.NONE, {
            count: colourItems.length, items: colourItems.slice(0, 60),
        }),
        type: section(families.length || typeItems.length ? STATUS.OK : STATUS.NONE, {
            families,
            tokens: typeItems.slice(0, 40),
            familiesCount: families.length,
            tokenCount: typeItems.length,
        }),
        geometry: section(geometryItems.length ? STATUS.OK : STATUS.NONE, {
            count: geometryItems.length, items: geometryItems.slice(0, 60),
        }),
        layout: section(bps.length ? STATUS.OK : STATUS.NONE, {
            breakpoints: bps.slice(0, 24),
            breakpointCount: bps.length,
        }),
        components: section(comps.length ? STATUS.OK : STATUS.NONE, {
            count: comps.length, items: comps.slice(0, 24),
        }),
        motion: section(motions.length ? STATUS.OK : STATUS.NONE, {
            count: motions.length, items: motions.slice(0, 40),
            keyframeCount: motions.filter((x) => x.kind === 'keyframes').length,
            reducedMotionPresent: motions.some((x) => /prefers-reduced-motion/.test(x.raw)),
        }),
        structure: section(skel ? STATUS.OK : STATUS.NONE, {
            skeleton: skel,
            textQuarantined: true,
        }),
        assets: section(assets.length ? STATUS.OK : STATUS.NONE, {
            count: assets.length, items: assets,
            hosts: [...new Set(assets.map((a) => a.host).filter(Boolean))],
        }),
    };

    return facts;
}

// Structural kind from a selector, using only the recoverable, non-hashed part.
// ".Button-module-scss-module__1SItCG__button" -> "button".
function kindOf(selector) {
    if (!selector) return 'unknown';
    const s = String(selector).toLowerCase();
    const clean = s.replace(/module__[a-z0-9]+/gi, '');
    const table = [
        ['button', /\bbtn\b|\bbutton\b/], ['link', /\blink\b/], ['input', /\binput\b|\bfield\b|\bform/],
        ['card', /\bcard\b/], ['nav', /\bnav\b|\bmenu\b|header/], ['footer', /footer/],
        ['heading', /\bhead/], ['text', /\btext\b|\bbody\b|\bprose\b/], ['icon', /\bicon\b/],
        ['dropdown', /\bdropdown\b|\bpopover\b|\bmodal\b/], ['list', /\blist\b|\bitem\b/],
        ['toc', /\btoc\b|\bsidebar\b/],
    ];
    for (const [kind, re] of table) if (re.test(clean)) return kind;
    return 'unknown';
}

module.exports = { buildDesignFacts, kindOf, normHex, px, bucketOf, STATUS };
