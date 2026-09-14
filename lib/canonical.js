// lib/canonical.js — deterministic serialization + hashing.
//
// Why this exists: DesignDNA is cached under a hash of DesignFacts. A hash of a
// non-canonical JSON string is not stable - key order in V8 follows insertion
// order for string keys, so two runs that build the same object literal in a
// different order would produce two cache entries and (worse) look like a
// cache-miss bug rather than a serialization bug. Canonical first, then hash.
//
// Rules: object keys sorted, arrays keep order (order is data), numbers via
// Number().toString() (no toFixed surprises), non-finite numbers -> null,
// undefined dropped from objects, NaN/Infinity are not silently stringified.

function canonicalize(value) {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'number') return Number.isFinite(value) ? value : null;
    if (t === 'string' || t === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => canonicalize(v));
    if (t === 'object') {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            const v = canonicalize(value[k]);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    return String(value);
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

const crypto = require('crypto');

function sha256(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

// Prefixed so a hash can be read for what it hashed.
// Fields that CANNOT change the DesignDNA, excluded from the cache identity.
// Why: the sanitized projection is identity-free by construction (gate 0 proves
// it), and it never reads source.url or source.fetchedAt. Including them meant a
// URL cache-buster ("?v=boltcheck") forked the cache for bytes that provably
// cannot alter the output - the exact failure this project already hit with the
// URL-keyed analysis cache. Everything else, including source.domain (which DOES
// drive redaction), stays in the hash, so any real design change still rotates it.
const VOLATILE_FACTS_PATHS = ['source.url', 'source.fetchedAt'];

function identityOfDesignFacts(designFacts) {
    const c = canonicalize(designFacts);
    for (const p of VOLATILE_FACTS_PATHS) {
        const parts = p.split('.');
        let node = c;
        for (let i = 0; i < parts.length - 1 && node; i++) node = node[parts[i]];
        if (node && typeof node === 'object') delete node[parts[parts.length - 1]];
    }
    return c;
}

function factsHash(designFacts) {
    return 'sha256:' + sha256(canonicalJson(identityOfDesignFacts(designFacts)));
}

module.exports = { canonicalize, canonicalJson, sha256, factsHash, identityOfDesignFacts, VOLATILE_FACTS_PATHS };
