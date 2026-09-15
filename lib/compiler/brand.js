// lib/compiler/brand.js — UserBrand -> renderable brand slot (P3 scope).
//
// P3 owns *integration*, not the full logo system (that is P6): resolve what the
// user gave us, validate the narrow safe paths, and fall back to a deterministic
// monogram so the compiler never blocks on a missing logo.
//
// Uploaded logos render ONLY as <img src="data:..."> — a context where SVG
// scripts cannot execute. Anything weirder than the exact allow-list regex is
// rejected loudly, never sanitized-and-shipped (that is P6's job with a real
// SVG sanitizer; until then, strictness is the security).
'use strict';
const { esc, hashInt, isHex } = require('./util.js');

const DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/;
const MAX_DATA_LEN = 200 * 1024;
// Patterns that must never appear inside an uploaded SVG payload even in <img>
// context (defense in depth; P6 replaces this with structural sanitization).
const SVG_UNSAFE = /<script|javascript:|onload\s*=|onerror\s*=|foreignobject|\bhref\s*=\s*["']?(https?:|data:)/i;

function firstCodePoint(s) {
    const chars = Array.from(String(s || '').trim());
    return chars.length ? chars[0] : '';
}

// Deterministic monogram: same (name, colors, posture) -> byte-identical SVG.
// The seed is the name itself, so even the shape choices are reproducible.
function monogram(name, tokens) {
    const letter = firstCodePoint(name).toUpperCase() || '?';
    const bg = (tokens && tokens['color-accent']) || '#3d5afe';
    const fg = (tokens && tokens['color-accent-ink']) || '#ffffff';
    const r = (tokens && tokens['radius-md']) || '10px';
    const rr = Math.min(parseFloat(r) || 0, 18);
    // two deterministic geometry variants selected by the name hash — visible
    // proof (and test target) that "generated" never means "random"
    const variant = hashInt('monogram:' + name, 2);
    const deco = variant === 0
        ? `<circle cx="36" cy="8" r="3" fill="${esc(fg)}" opacity="0.35"/>`
        : `<rect x="32" y="6" width="8" height="3" rx="1.5" fill="${esc(fg)}" opacity="0.35"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="${esc(name || 'Logo')}">`
        + `<rect width="48" height="48" rx="${rr}" fill="${esc(bg)}"/>${deco}`
        + `<text x="24" y="32" text-anchor="middle" font-family="system-ui, sans-serif" font-size="22" font-weight="600" fill="${esc(fg)}">${esc(letter)}</text></svg>`;
}

/**
 * @returns {{name:string, tagline:string, logoHtml:string, logoAsset:object|null, mode:string}}
 */
function resolveBrand(brand, tokens) {
    const b = brand || {};
    const name = String(b.name || '').trim().slice(0, 64);
    if (!name) throw new Error('UserBrand.name is required');
    const tagline = String(b.tagline || '').trim().slice(0, 140);
    const logo = b.logo || {};
    const alt = esc(String(logo.alt || (name + ' logo')).slice(0, 160));

    if (logo.mode === 'upload') {
        const d = String(logo.dataUrl || '');
        const m = DATA_URL.exec(d);
        if (!m) throw new Error('logo.dataUrl must be a base64 data: image URL (png/jpeg/webp/gif/svg)');
        if (d.length > MAX_DATA_LEN) throw new Error('logo.dataUrl exceeds 200KB');
        if (m[1] === 'svg+xml') {
            // The base64 hides the markup, so decode BEFORE judging. Scan the
            // decoded bytes — scanning the encoded string would match nothing
            // and reassure us falsely (a known instrument failure class here).
            const decoded = Buffer.from(m[2], 'base64').toString('latin1');
            if (SVG_UNSAFE.test(decoded)) throw new Error('uploaded SVG contains script/handler/external-ref patterns; rejected');
        }
        const ext = ({ 'svg+xml': 'svg', png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' })[m[1]];
        return { name, tagline, mode: 'upload', logoAsset: { path: 'assets/logo.' + ext, mime: 'image/' + m[1], dataUrl: d },
            logoHtml: `<img class="brand-logo" src="${d}" alt="${alt}" width="32" height="32">` };
    }

    // generated (default) AND text mode — P3's generated logo is the monogram;
    // P6 upgrades generation and swaps in upload-sanitization without touching
    // this call signature.
    const svg = monogram(name, tokens);
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    return { name, tagline, mode: 'generated', logoAsset: { path: 'assets/logo.svg', mime: 'image/svg+xml', dataUrl },
        logoHtml: `<span class="brand-mark" aria-hidden="true">${svg}</span>` };
}

module.exports = { resolveBrand, monogram, firstCodePoint, DATA_URL, MAX_DATA_LEN, SVG_UNSAFE };
