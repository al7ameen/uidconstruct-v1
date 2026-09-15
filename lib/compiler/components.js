// lib/compiler/components.js — ContentSpec -> HTML, one pure function per
// controlled component. THE AI NEVER WRITES MARKUP; these functions do.
//
// Invariants:
//   * every string from ContentSpec/UserBrand passes through esc() at the
//     interpolation site — there is no path from input text to HTML that skips it;
//   * every href passes through safeHref(), so even a schema-escaped URL renders
//     inert (two independent layers, schema + render);
//   * output order is data order; no sorting, no randomness, no Date — the same
//     spec renders byte-identical forever;
//   * markup is semantic + class-driven; all styling lives in CSS tokens.
'use strict';
const { esc, safeHref } = require('./util.js');

const join = (parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n');

function Button(item, extraClass) {
    const cls = 'btn btn-' + (item.kind === 'secondary' ? 'ghost' : 'solid') + (extraClass ? ' ' + extraClass : '');
    return `<a class="${cls}" href="${safeHref(item.href)}">${esc(item.label)}</a>`;
}

function Nav(nav, brand) {
    const links = (nav.items || []).map((i) => `<a class="nav-link" href="${safeHref(i.href)}">${esc(i.label)}</a>`);
    const cta = nav.cta ? Button(nav.cta, 'btn-sm') : '';
    return `<header class="site-header"><div class="container header-inner">`
        + `<a class="brand" href="#top">${brand.logoHtml}<span class="brand-name">${esc(brand.name)}</span></a>`
        + `<nav class="nav-links" aria-label="Main">${join(links)}</nav>`
        + `<div class="header-cta">${cta}</div>`
        + `<button class="nav-toggle" aria-expanded="false" aria-controls="mnav"><span class="nav-toggle-bar"></span><span class="sr-only">Menu</span></button>`
        + `</div><nav id="mnav" class="mobile-nav" hidden aria-label="Mobile">${join(nav.items.map((i) => `<a class="nav-link" href="${safeHref(i.href)}">${esc(i.label)}</a>`))}${cta}</nav></header>`;
    /* NOTE: mobile-nav duplicates link list — deterministic, no cloning logic. */
}

function Hero(hero) {
    const eb = hero.eyebrow ? `<p class="eyebrow">${esc(hero.eyebrow)}</p>` : '';
    const ctas = join((hero.ctas || []).map((c) => Button(c)));
    return `<section class="hero" id="top"><div class="container hero-inner">${eb}`
        + `<h1 class="hero-heading">${esc(hero.heading)}</h1>`
        + `<p class="hero-sub">${esc(hero.sub)}</p>`
        + `<div class="hero-actions">${ctas}</div></div></section>`;
}

const renderers = {
    FEATURE_GRID(s) {
        const cards = s.items.map((it) => `<div class="card feature-card"><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div>`);
        return `<article class="section" id="${safeHref(s.id).slice(1)}"><div class="container">${SectionHead(s)}`
            + `<div class="grid grid-cards">${join(cards)}</div></div></article>`;
    },
    FEATURE_LIST(s) {
        const rows = s.items.map((it) => `<li class="feature-row"><div><h3>${esc(it.title)}</h3><p>${esc(it.body)}</p></div></li>`);
        return `<article class="section" id="${safeHref(s.id).slice(1)}"><div class="container">${SectionHead(s)}`
            + `<ul class="feature-list">${join(rows)}</ul></div></article>`;
    },
    STATS(s) {
        const cells = s.items.map((it) => `<div class="stat"><span class="stat-value">${esc(it.value)}</span><span class="stat-label">${esc(it.label)}</span></div>`);
        return `<article class="section section-alt" id="${safeHref(s.id).slice(1)}"><div class="container">${SectionHead(s)}`
            + `<div class="grid grid-stats">${join(cells)}</div></div></article>`;
    },
    QUOTE(s) {
        const q = s.items[0];
        const cite = q.cite ? `<figcaption>${esc(q.cite)}</figcaption>` : '';
        return `<article class="section" id="${safeHref(s.id).slice(1)}"><div class="container">${SectionHead(s)}`
            + `<blockquote class="pull-quote"><p>${esc(q.text)}</p>${cite}</blockquote></div></article>`;
    },
    GALLERY(s) {
        // Placeholder tiles, NOT reference imagery: identity firewall means zero
        // fetched images ship in the site. Colour tiles come from tokens.
        const tiles = s.items.map((it, i) => `<figure class="tile"><div class="tile-art" data-tile="${i}"></div>`
            + `<figcaption>${esc(it.title)}${it.caption ? ' — ' + esc(it.caption) : ''}</figcaption></figure>`);
        return `<article class="section section-alt" id="${safeHref(s.id).slice(1)}"><div class="container">${SectionHead(s)}`
            + `<div class="grid grid-tiles">${join(tiles)}</div></div></article>`;
    },
    TEXT(s) {
        const paras = s.items.map((it) => `<p class="prose">${esc(it.body)}</p>`);
        return `<article class="section" id="${safeHref(s.id).slice(1)}"><div class="container narrow">${SectionHead(s)}${join(paras)}</div></article>`;
    },
    CTA(s, ctx) {
        const c = s.items[0];
        // Button reuses the nav CTA (label + href) when the spec has one; we do
        // NOT invent English UI copy in the compiler, and we do not read fields
        // the schema does not define.
        const btn = ctx && ctx.navCta
            ? `<a class="btn btn-solid" href="${safeHref(ctx.navCta.href)}">${esc(ctx.navCta.label)}</a>` : '';
        return `<article class="section section-cta" id="${safeHref(s.id).slice(1)}"><div class="container cta-inner">`
            + `<h2>${esc(c.heading)}</h2><p>${esc(c.body)}</p>${btn}</div></article>`;
    },
};

function SectionHead(s) {
    const lead = s.lead ? `<p class="section-lead">${esc(s.lead)}</p>` : '';
    return `<div class="section-head"><h2>${esc(s.title)}</h2>${lead}</div>`;
}

function Sections(sections, ctx) {
    return join(sections.map((s) => {
        const r = renderers[s.type];
        if (!r) throw new Error('compiler: unmapped section type "' + s.type + '" (schema should have rejected it)');
        return r(s, ctx || {});
    }));
}

function Footer(f, brand) {
    const cols = (f.columns || []).map((c) => `<div class="foot-col"><h4>${esc(c.title)}</h4>`
        + c.links.map((l) => `<span class="foot-link">${esc(l.label)}</span>`).join('') + `</div>`);
    const fine = f.fine || ('© ' + brand.name);  // esc happens once, at render below
    return `<footer class="site-footer"><div class="container"><div class="foot-grid">`
        + `<div class="foot-brand">${brand.logoHtml}<p>${esc(f.blurb)}</p></div>${join(cols)}`
        + `</div><p class="foot-fine">${esc(fine)}</p></div></footer>`;
}

module.exports = { Nav, Hero, Sections, Footer, Button, renderers };
