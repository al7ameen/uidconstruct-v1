// lib/compiler/content-schema.js — contentspec/1, the compiler's INPUT contract.
//
// P4 will GENERATE this object with AI Call #2; P3 consumes it. The schema lives
// here, in the compiler, on purpose: the consumer defines what it accepts, and
// P4 must satisfy it. Reuses the same strict validator that guards DesignDNA —
// unknown keys rejected, loud errors, no partial acceptance. (dna.test.js's
// C14-C15 lesson: a gate that rejects nothing is theatre.)
//
// Every text field is a plain string. There is no field where HTML/CSS/JS could
// legally go, because the AI must not emit markup — the compiler owns markup.
// Links are in-page anchors only ('#features'); the schema enforces it.
'use strict';
const { validate, TYPES } = require('../schema.js');

const LABEL = { type: 'string', max: 60 };
const SENTENCE = { type: 'string', max: 240 };
const ANCHOR = {
    type: (v) => {
        if (typeof v !== 'string' || !v) return false;
        // '#id' in-page fragment; nothing else. (safeHref defends again at
        // render time; two independent layers because this string reaches DOM.)
        return /^#[A-Za-z0-9_-]{1,40}$/.test(v);
    },
    typeName: 'anchor "#id"',
};

const SECTION_TYPES = ['FEATURE_GRID', 'FEATURE_LIST', 'STATS', 'QUOTE', 'GALLERY', 'TEXT', 'CTA'];

const ITEM_BY_TYPE = {
    FEATURE_GRID: { type: 'object', spec: { title: LABEL, body: SENTENCE } },
    FEATURE_LIST: { type: 'object', spec: { title: LABEL, body: SENTENCE } },
    STATS: { type: 'object', spec: { value: { type: 'string', max: 24 }, label: { type: 'string', max: 48 } } },
    QUOTE: { type: 'object', spec: { text: { type: 'string', max: 400 }, cite: { type: 'string', max: 60 } } },
    GALLERY: { type: 'object', spec: { title: LABEL, caption: { type: 'string', max: 80, required: false } } },
    TEXT: { type: 'object', spec: { body: { type: 'string', max: 800 } } },
    CTA: { type: 'object', spec: { heading: LABEL, body: SENTENCE } },
};

const CONTENT_SCHEMA = {
    type: 'object',
    spec: {
        schema: { type: (v) => v === 'contentspec/1', typeName: '"contentspec/1"' },
        brand: {
            type: 'object',
            spec: {
                name: { type: 'string', max: 64 },
                tagline: { type: 'string', max: 140, required: false },
            },
        },
        nav: {
            type: 'object',
            spec: {
                items: { type: 'array', min: 1, max: 6, unique: true, uniqueBy: 'href',
                    of: { type: 'object', spec: { label: LABEL, href: ANCHOR } } },
                cta: { type: 'object', required: false, spec: { label: LABEL, href: ANCHOR } },
            },
        },
        hero: {
            type: 'object',
            spec: {
                eyebrow: { type: 'string', max: 40, required: false },
                heading: { type: 'string', max: 90 },
                sub: { type: 'string', max: 240 },
                ctas: { type: 'array', min: 1, max: 2,
                    of: { type: 'object', spec: { label: LABEL, kind: { type: TYPES.enum(['primary', 'secondary']) }, href: ANCHOR } } },
            },
        },
        sections: {
            type: 'array', min: 2, max: 8,
            of: {
                type: 'object',
                spec: {
                    id: ANCHOR,
                    type: { type: TYPES.enum(SECTION_TYPES) },
                    title: LABEL,
                    lead: { type: 'string', max: 240, required: false },
                    items: { type: 'array', min: 1, max: 8, of: { type: (v) => v && typeof v === 'object', typeName: 'object' } },
                },
            },
        },
        footer: {
            type: 'object',
            spec: {
                blurb: { type: 'string', max: 160 },
                columns: {
                    type: 'array', min: 0, max: 4, required: false,
                    of: { type: 'object', spec: { title: LABEL, links: { type: 'array', min: 1, max: 6, of: { type: 'object', spec: { label: LABEL } } } } },
                },
                fine: { type: 'string', max: 120, required: false },
            },
        },
    },
};

// Section items must match their type's shape — validate() can't express
// discriminated unions, so this pass does, loudly.
function validateItems(content) {
    const errs = [];
    (content.sections || []).forEach((s, i) => {
        const spec = ITEM_BY_TYPE[s && s.type];
        if (!spec) { errs.push(`$.sections[${i}].type: unknown section type`); return; }
        (s.items || []).forEach((it, j) => {
            const sub = [];
            validate(it, spec, `$.sections[${i}].items[${j}]`, sub);
            errs.push(...sub);
        });
    });
    return errs;
}

function validateContent(content) {
    const errs = [];
    validate(content, CONTENT_SCHEMA, '$', errs);
    errs.push(...validateItems(content));
    return { ok: errs.length === 0, errors: errs };
}

module.exports = { validateContent, CONTENT_SCHEMA, ITEM_BY_TYPE, SECTION_TYPES };
