// lib/userbrand.js — userbrand/1: the ONLY identity allowed in a generated site.
//
// ARCHITECTURE §3 defines the shape. This file is its single source of truth for
// P4 input validation. NOTE the firewall policy: the compiler's tier-1 scan has
// ZERO exemptions — userSuppliedStrings was removed as a dead seam that implied
// otherwise (measured: makeScanner only fires on the full token, so near-collisions
// like 'Zephyr Analytics' were never the over-strict case this promised to fix).
//
// Division of labour, deliberate:
//   validateUserBrand  -> SHAPE + bounds. Cheap, structural, no image parsing.
//   compiler/brand.js  -> SECURITY of the logo bytes (data-URI allow-list, decoded
//                         SVG scan, size cap). Not duplicated here on purpose: two
//                         copies of a security rule is two chances to fix one.
'use strict';
const { validate, TYPES } = require('./schema.js');

const USERBRAND_VERSION = 'userbrand/1';
// 'text' is accepted because brand.js documents it and falls through to the
// monogram path; rejecting it here would make a legal compiler input illegal here.
const LOGO_MODES = ['upload', 'generated', 'text'];

const USERBRAND_SCHEMA = {
    type: 'object',
    spec: {
        schema: { type: (v) => v === USERBRAND_VERSION, typeName: '"' + USERBRAND_VERSION + '"', required: false },
        name: { type: 'string', max: 64 },                       // TYPES.string => non-empty
        tagline: { type: 'string', max: 140, required: false },
        description: { type: 'string', max: 2000, required: false },
        logo: {
            type: 'object', required: false,
            spec: {
                mode: { type: TYPES.enum(LOGO_MODES), required: false },
                dataUrl: { type: 'string', required: false },
                svg: { type: 'string', required: false },
                alt: { type: 'string', max: 160, required: false },
            },
        },
        paletteHint: { type: TYPES.enum(['any', 'match-brand']), required: false },
    },
};

function validateUserBrand(brand) {
    const errs = [];
    if (brand === null || typeof brand !== 'object' || Array.isArray(brand)) {
        return { ok: false, errors: ['$: UserBrand must be an object'] };
    }
    validate(brand, USERBRAND_SCHEMA, '$', errs);
    return { ok: errs.length === 0, errors: errs };
}

// Stage policy, kept separate from shape: buildContent cannot write copy about a
// product with no description, and "description is missing" is a different
// message from "description is malformed".
function requireDescription(brand) {
    const d = (brand && brand.description) || '';
    return typeof d === 'string' && d.trim().length >= 10;
}

module.exports = {
    USERBRAND_VERSION, USERBRAND_SCHEMA, LOGO_MODES,
    validateUserBrand, requireDescription,
};
