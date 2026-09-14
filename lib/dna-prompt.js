// lib/dna-prompt.js — the AI #1 prompt. Deterministic by construction.
//
// Two properties this file is responsible for:
//   1. It is built ONLY from the sanitized projection. It has no access to
//      DesignFacts, so it cannot leak identity even if someone forgets to.
//   2. Same input -> byte-identical output. No Date.now(), no randomness, no
//      iteration over an unordered object. That is what makes the DNA cache key
//      meaningful and what makes "the model was given X" provable in a test.
//
// Note on the JSON.stringify space argument: it is pinned to 2 so the serialized
// projection is stable across Node versions rather than minified-vs-pretty by
// accident.

const { canonicalJson } = require('./canonical.js');

const SYSTEM = [
    'You are a design-language analyst.',
    'You are given a machine-extracted, sanitized description of ONE web page: numeric design',
    'tokens, colour values, breakpoint widths, component kinds, motion counts and element counts.',
    '',
    'You are NOT given the page URL, its name, its text content, its asset URLs, or its font',
    'family names. Do not attempt to guess them. If you find yourself producing a brand name,',
    'a company, a product, or an industry, stop: that is a failure, not an insight.',
    '',
    'Your output describes a transferable DESIGN LANGUAGE: relationships, proportions and',
    'postures that could be applied to a completely different brand. It must contain nothing',
    'that identifies where it came from.',
    '',
    'HARD RULES:',
    '1. Every factual value you emit (hex colour, number, px) MUST appear literally in the',
    '   input, or be exactly computable from it (e.g. a base unit that divides all observed',
    '   spacing values; a scale ratio that is the quotient of two observed type sizes).',
    '2. If a value is not present in the input and not computable from it, you must NOT invent',
    '   it. Set that section\'s "status" to "unavailable" and null its numbers. "I do not know"',
    '   is a correct answer. A plausible guess is a wrong answer.',
    '3. Assign semantic roles to observed colours. Use only these roles: canvas, surface,',
    '   surface-alt, text, text-muted, accent, accent-text, border, success, warning, danger.',
    '   Roles "canvas", "text" and "accent" are required whenever any colour was observed.',
    '4. Emit ONLY the JSON object described below. No prose, no markdown fence, no commentary.',
    '5. Do not echo the input. Interpret it.',
    '',
    '6. Token names are NOT given. Each arrives as { alias, label, value } - alias is an opaque',
    'id like c3 or g7, label a generic concept like radius, weight, spacing. Cite colours by',
    'alias in factRef. Never write a CSS custom property name (anything starting with two',
    'hyphens): you were never given one, so producing one means you invented it.',
    '',
    'About font families: you receive CATEGORIES only (e.g. ["sans","serif","mono"]) because',
    'names carry identity. Judge hierarchy from categories and numeric size tokens alone.',
].join('\n');

function userPrompt(projection) {
    return [
        'INPUT (schema ' + projection.schema + ')',
        '',
        canonicalJson(projection),
        '',
        'Return one JSON object exactly matching this shape, with every field present:',
        '',
        TARGET_SHAPE,
        '',
        'Remember: values not present in the INPUT and not computable from it must be reported',
        'as status "unavailable" with null numbers, and named in "gaps".',
    ].join('\n');
}

// The shape is shown as an example skeleton, not as prose instructions, because
// qwen follows a literal template far more reliably than a paragraph of rules.
const TARGET_SHAPE = [
    '{',
    '  "schema": "designdna/1",',
    '  "factsHash": "<copy the factsHash field from the INPUT verbatim>",',
    '  "model": "<copy the model field from the INPUT verbatim>",',
    '  "identity": { "referenceName": null, "referenceDomain": null },',
    '  "palette": {',
    '    "roles": [ { "role": "canvas", "value": "#hexfrominput", "factRef": "c1" } ],',
    '    "temperature": "warm|neutral|cool",',
    '    "saturation": "none|low|medium|high",',
    '    "contrastStrategy": "high|medium|low"',
    '  },',
    '  "typography": { "status": "extracted|unavailable", "hierarchy": "modular|fluid|stepped|unknown", "scaleRatio": 1.25, "display": "serif|sans|mono|slab|script|unknown", "body": "serif|sans|mono|unknown", "weightsUsed": [400] },',
    '  "spacing":    { "status": "extracted|unavailable", "baseUnit": 8, "rhythm": "tight|normal|loose|unknown" },',
    '  "radius":     { "status": "extracted|unavailable", "posture": "sharp|soft|pill|mixed|unknown", "values": ["16px"] },',
    '  "layout":     { "status": "extracted|unavailable", "density": "airy|normal|dense|unknown", "maxWidth": 1200, "breakpointLadder": [640] },',
    '  "components": { "status": "extracted|unavailable", "idioms": [ { "kind": "button", "pattern": "short description of the visual idiom" } ] },',
    '  "motion":     { "status": "extracted|unavailable", "signature": "none|subtle|reveal|playful|unknown", "honoursReducedMotion": true, "durationsMs": [200] },',
    '  "voice":      { "tone": "plain|technical|playful|formal|unknown", "sentenceLength": "short|medium|long|unknown", "structuralLabels": ["features"] },',
    '  "principles": [ "A sentence about how this design language works.", "Another principle." ],',
    '  "gaps": [ "what could not be determined from the input" ]',
    '}',
].join('\n');

function buildMessages(projection) {
    return [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(projection) },
    ];
}

function repairMessages(projection, invalidDna, errors) {
    const lines = errors.slice(0, 12).map((e) => '- ' + e.kind + ' ' + e.path + ': ' + e.message);
    return [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(projection) },
        {
            role: 'user',
            content: [
                'Your previous answer was rejected. It violated these rules:',
                '',
                lines.join('\n'),
                '',
                'Your previous answer was:',
                canonicalJson(invalidDna),
                '',
                'Answer again with the corrected JSON object only. For any value you cannot',
                'ground in the INPUT, set that section status to "unavailable", null the number,',
                'and list it in "gaps". Never substitute a plausible number.',
            ].join('\n'),
        },
    ];
}

module.exports = { SYSTEM, TARGET_SHAPE, buildMessages, repairMessages, userPrompt };
