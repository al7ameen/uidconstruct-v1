// lib/content-prompt.js — the AI #2 prompt. Deterministic by construction.
//
// Mirrors lib/dna-prompt.js and inherits its two properties:
//   1. Built ONLY from what it is handed (an interpretive DNA slice + the user's
//      own brand strings). It has no access to DesignFacts, source URLs, or asset
//      hosts, so it cannot leak reference identity even if a caller forgets to.
//   2. Same input -> byte-identical output. No Date, no randomness, no unordered
//      object iteration. That is what lets the cache key be a hash of the prompt.
//
// WHAT IS DELIBERATELY ABSENT, and why it matters more than what is present:
// every factual design value — hex colours, px, ms, ratios, breakpoints. Those are
// already in DesignDNA, grounded against real CSS, and the compiler reads them
// directly. Re-sending them would (a) invite the model to "regenerate" numbers it
// cannot know, which is the exact failure Locked Rule #1 exists to stop, and
// (b) waste input tokens on data that must not change. So the model is given the
// design language as WORDS (density, posture, tone, idioms) and asked only for
// content: structure and copy. It never sees a number it could paraphrase wrongly.
'use strict';
const { canonicalJson } = require('./canonical.js');

// The interpretive slice of DesignDNA. A fixed key list, not "spread and delete",
// so a future DNA field cannot silently ride along into this prompt.
const DNA_TEXT_FIELDS = [
    ['voice', ['tone', 'sentenceLength', 'structuralLabels']],
    ['palette', ['temperature', 'saturation', 'contrastStrategy']],
    ['typography', ['status', 'hierarchy', 'display', 'body']],
    ['spacing', ['status', 'rhythm']],
    ['radius', ['status', 'posture']],
    ['layout', ['status', 'density']],
    ['components', ['status', 'idioms']],
    ['motion', ['status', 'signature']],
];

// DNA -> the only part of it the copywriter may see. String enums and prose only.
function dnaToText(dna) {
    const out = {};
    for (const [section, keys] of DNA_TEXT_FIELDS) {
        const src = (dna && dna[section]) || {};
        const dst = {};
        for (const k of keys) {
            const v = src[k];
            if (v === undefined || v === null) continue;
            if (Array.isArray(v)) {
                const strs = v.filter((x) => typeof x === 'string');
                if (strs.length) dst[k] = strs;
                else if (section === 'components' && k === 'idioms') {
                    // idioms is [{kind,pattern}] — text, but not strings. Keep the
                    // shape; it carries no numbers.
                    dst[k] = v.filter((x) => x && typeof x === 'object')
                        .map((x) => ({ kind: String(x.kind || ''), pattern: String(x.pattern || '') }));
                }
            } else if (typeof v === 'string') {
                dst[k] = v;
            }
            // numbers are dropped by construction: this function has no numeric branch
        }
        if (Object.keys(dst).length) out[section] = dst;
    }
    if (Array.isArray(dna && dna.principles)) out.principles = dna.principles.filter((x) => typeof x === 'string');
    if (Array.isArray(dna && dna.gaps)) out.gaps = dna.gaps.filter((x) => typeof x === 'string');
    return out;
}

const SYSTEM = [
    'You are a website content strategist and copywriter. You design the INFORMATION ARCHITECTURE',
    'and write the COPY for one landing page for the customer described in the INPUT.',
    '',
    'You are given two things, and nothing else:',
    '  - brand: the customer\'s own name, tagline, and product description. This is the ONLY',
    '    subject you write about.',
    '  - designLanguage: a description of the VISUAL style of the page, expressed in words only',
    '    (density, posture, tone, component idioms). It contains no colours, no pixel values,',
    '    and no brand names. It tells you how the page should FEEL, not what to say.',
    '',
    'You are NOT given, and must never mention or guess: the name, domain, company, product, or',
    'any text of the website the design language was derived from. If a phrase in the INPUT',
    'looks like a third-party brand name, it is not yours to use: your subject is `brand` only.',
    '',
    'HARD RULES:',
    '1. Emit ONLY one JSON object matching the shape given. No prose, no markdown fence,',
    '   no commentary. Do not echo the INPUT.',
    '2. Every string is plain text. NEVER emit HTML, CSS, JavaScript, angle brackets, markdown,',
    '   emoji-as-icon, or URLs. The renderer owns markup; you own words.',
    '3. Links are in-page anchors only, of the form "#word" (example: "#features"). No external',
    '   links, no mailto, no tel. Every nav href must equal the id of a section you define,',
    '   or "#top".',
    '4. Respect every length limit shown in the shape. Short is expected: these are labels and',
    '   headlines, not paragraphs.',
    '5. Write ORIGINAL copy for this product, derived from `brand.description`. Do not use',
    '   template filler ("Lorem ipsum", "Your headline here", "Feature one"), and do not',
    '   restate the tagline as the headline.',
    '6. HONESTY (absolute): do not invent facts. No invented numbers, counts, percentages,',
    '   uptime, prices, dates, customer totals, awards, certifications, or named people.',
    '   A "STATS" section is allowed ONLY when `brand.description` states those figures',
    '   itself; then copy them exactly. A testimonial QUOTE is allowed ONLY when the',
    '   description supplies it. Otherwise use FEATURE_GRID, FEATURE_LIST, TEXT, GALLERY,',
    '   and CTA. Making up a statistic or a customer quote is a lie on the customer\'s',
    '   website, and the most common way generated sites get their owners in trouble.',
    '7. Do not invent legal claims (free trials, refunds, SLAs, compliance, "no credit card",',
    '   guarantees) unless the description states them.',
    '8. brand.name in your output must be exactly the name given in INPUT.brand.name.',
    '9. Match the voice: if designLanguage.voice.tone is "technical", be concrete and',
    '   unsentimental; "playful" allows wit; "formal" forbids slang. Prefer verbs and specifics',
    '   over adjectives. Sentence length should follow designLanguage.voice.sentenceLength.',
    '10. Use designLanguage.voice.structuralLabels as a hint for section titles when they fit',
    '    the product (they describe how the reference page was organized, not what this',
    '    product is). Section ids must be derived from your own titles.',
    '11. 3 to 6 sections is normal. Each section needs 1-8 items. Keep the page coherent:',
    '    a hero, what it does, how/why it matters, a closing call to action.',
].join('\n');

// The shape is a literal template because qwen follows an example far more
// reliably than a paragraph of prose rules. Limits are annotated inline since the
// model cannot see the JSON schema.
const TARGET_SHAPE = [
    '{',
    '  "schema": "contentspec/1",',
    '  "brand": { "name": "<exact INPUT.brand.name>", "tagline": "<optional, <=140 chars>" },',
    '  "nav": {',
    '    "items": [ { "label": "<=60 chars", "href": "#features" } ],   // 1-6 items',
    '    "cta":  { "label": "<=60 chars", "href": "#start" }             // optional',
    '  },',
    '  "hero": {',
    '    "eyebrow": "<optional <=40 chars>",',
    '    "heading": "<=90 chars, the main promise>",',
    '    "sub":     "<=240 chars, one sentence of substance>",',
    '    "ctas":    [ { "label": "<=60", "kind": "primary"  , "href": "#start" },',
    '                 { "label": "<=60", "kind": "secondary", "href": "#features" } ]  // 1-2, kind is primary|secondary',
    '  },',
    '  "sections": [                                                 // 2-8 sections',
    '    { "id": "#features", "type": "FEATURE_GRID", "title": "<=60", "lead": "<optional <=240>",',
    '      "items": [ { "title": "<=60", "body": "<=240" } ] },      // 1-8 items',
    '',
    '    // "type" is one of these six, and items must match it EXACTLY:',
    '    //   FEATURE_GRID / FEATURE_LIST -> { "title": <=60, "body": <=240 }',
    '    //   STATS      -> { "value": <=24, "label": <=48 }   (only if the description gave them; rule 6)',
    '    //   QUOTE      -> { "text": <=400, "cite": <=60 }     (only if the description gave it; rule 6)',
    '    //   GALLERY    -> { "title": <=60, "caption": <=80 }   caption optional',
    '    //   TEXT       -> { "body": <=800 }',
    '    //   CTA        -> { "heading": <=60, "body": <=240 }',
    '  ],',
    '  "footer": {',
    '    "blurb": "<=160 chars>",',
    '    "columns": [ { "title": "<=60", "links": [ { "label": "<=60" } ] } ],  // optional, 0-4 columns, labels only',
    '    "fine": "<optional <=120 chars>"',
    '  }',
    '}',
].join('\n');

function userPrompt(brand, dnaText) {
    return [
        'INPUT (JSON)',
        '',
        canonicalJson({ brand: { name: brand.name, tagline: brand.tagline, description: brand.description }, designLanguage: dnaText }),
        '',
        'Return one JSON object exactly matching this shape, with every required field present:',
        '',
        TARGET_SHAPE,
        '',
        'Remember: plain text only, anchors only, no invented numbers or quotes, and your',
        'subject is `brand` — never the source of the design language.',
    ].join('\n');
}

function buildMessages(brand, dna) {
    return [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(brand, dnaToText(dna)) },
    ];
}

module.exports = { SYSTEM, TARGET_SHAPE, DNA_TEXT_FIELDS, dnaToText, userPrompt, buildMessages };
