// lib/compiler/util.js — shared deterministic primitives for the P3 compiler.
//
// Every function here is PURE and free of Date/Math.random: the whole phase rests
// on "same inputs -> byte-identical output", so randomness and wall-clock reads
// are banned from this directory by construction. If a value is not derived from
// an argument, it does not belong here.
'use strict';

// ---- clamping / rounding -----------------------------------------------------
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round(n, dp) { const f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }

// ---- colour maths (real, not cosmetic) --------------------------------------
// Deterministic and testable; deliberately NOT color-mix(): that was unverifiable
// by this project's harness before (uidconstruct_verify_color_mix_trap).
function hexToRgb(hex) {
    let s = String(hex || '').trim().toLowerCase();
    if (s[0] === '#') s = s.slice(1);
    if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/.test(s)) return null;
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
    const h = (x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
}
// t=0 -> a, t=1 -> b
function mix(a, b, t) {
    const A = hexToRgb(a) || { r: 255, g: 255, b: 255 };
    const B = hexToRgb(b) || { r: 0, g: 0, b: 0 };
    const k = clamp(t, 0, 1);
    return rgbToHex(A.r + (B.r - A.r) * k, A.g + (B.g - A.g) * k, A.b + (B.b - A.b) * k);
}
function relLuminance(hex) {
    const c = hexToRgb(hex) || { r: 255, g: 255, b: 255 };
    const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
// WCAG 2.1 contrast ratio, same formula the frontend harness uses.
function contrast(a, b) {
    const L1 = relLuminance(a), L2 = relLuminance(b);
    return round((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), 2);
}
// Pick white or black for text on `bg`, whichever reads better; never a guess.
function readableOn(bg) {
    const cw = contrast(bg, '#ffffff');
    const cb = contrast(bg, '#000000');
    return cw >= cb ? '#ffffff' : '#000000';
}
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

// ---- HTML escaping (the XSS firewall for user + AI text) --------------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}
// A URL is allowed only as an in-page anchor, a plain https link, or mailto/tel.
// Everything else (javascript:, data:text/html, protocol-relative) is dropped to
// '#'. The compiler never emits a reference-external asset URL in the first place.
function safeHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return '#';
    if (raw.startsWith('#')) return esc(raw);
    if (/^https:\/\//i.test(raw)) return esc(raw);
    if (/^mailto:/i.test(raw) || /^tel:/i.test(raw)) return esc(raw);
    return '#';
}

// ---- deterministic seed string ----------------------------------------------
const { sha256 } = require('../canonical.js');
// Turn any string into a hex-integer seed stream, stable across runs/platforms.
function seedDigits(str) { return sha256(String(str)); }
function hashInt(str, n) { // deterministic int in [0,n)
    const h = seedDigits(str);
    return n <= 0 ? 0 : parseInt(h.slice(0, 8), 16) % n;
}

module.exports = { clamp, round, hexToRgb, rgbToHex, mix, relLuminance, contrast, readableOn, isHex, esc, safeHref, sha256, seedDigits, hashInt };
