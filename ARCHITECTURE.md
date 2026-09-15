# UIDConstruct V1 — Architecture Contracts (P1)

> Status: **binding**. Every later phase (P3 compiler, P4 content, P5 UI, P6 preview/export,
> P7 QA) implements against these shapes. Changing a contract means a version bump and a
> schema test, never a silent edit. Design principle: **we learn design language, never
> website identity.**

Pipeline (final, settled at P1):

```
reference URL
  → safeFetch (SSRF-guarded, revalidated per redirect hop)        [lib/net.js — exists]
  → cheerio.load
  → buildAnalysisPrompt(html,$)  → extracted                      [lib/pipeline.js — exists]
  → buildDesignFacts(extracted)  → DesignFacts  designfacts/1     [lib/facts.js — exists]
  → identity-free projection                                      [lib/projection.js — exists]
  → AI Call #1 (exactly one)     → DesignDNA    designdna/1       [lib/dna.js — exists]
  → schema + grounding validation, cached by factsHash            [exists]
  → UserBrand (user input, never touches reference)
  → AI Call #2 (exactly one)     → ContentSpec contentspec/1      [P4]
  → identity scan of ContentSpec                                  [P5]
  → deterministic compiler (zero AI) → GeneratedSite site/1       [P3]
  → identity scan of GeneratedSite → PASS / GENERATION FAILED     [P5]
  → sandboxed srcdoc preview, brand-edit re-runs only #2+compile  [P6]
  → client-side ZIP export, no storage                            [P6]
```

**AI budget rule (global, enforced):** one website generation performs at most 2 raw AI
calls — one per stage. `buildDna`'s existing repair retry is therefore **disabled on the
generation path** (`{ repair: false }`); it remains available to standalone DNA analysis.
An invalid answer fails honestly; it does not spend budget.

## 1. DesignFacts — `designfacts/1` (exists; authoritative impl: lib/facts.js)

Deterministic, status-tagged, values verbatim from extraction. Nothing invented, absence
explicit (`extracted | unavailable | truncated`). Top-level: `schema, source{url,domain,
fetchedAt,httpStatus}, status{degraded,truncated,droppedCssLinks,cssBytes,htmlBytes,notes},
colour, type{families,tokens,…}, geometry, layout{breakpoints}, components{items[].kind},
motion, structure{skeleton,textQuarantined:true}, assets{items[].url,hosts}`.

Policy (measured, not taste): `pageOutline` (4.7 KB of visible copy, 44× brand-name hits
on claude.com) is **never collected into facts**; it survives only in `extracted` for the
legacy analysis endpoint. Facts keep brand font families verbatim — stripping is
projection's job, so sanitisation stays auditable.

## 2. DesignDNA — `designdna/1` (exists; frozen; impl: lib/schema.js + ground.js)

Top keys: `schema, factsHash(sha256:…), model, identity{referenceName:null,
referenceDomain:null}, palette{roles[{role:canvas|surface|surface-alt|text|text-muted|
accent|accent-text|border|success|warning|danger, value:#hex, factRef?, confidence?}],
temperature, saturation, contrastStrategy}, typography{status,hierarchy,scaleRatio,display,
body,weightsUsed}, spacing{status,baseUnit,rhythm}, radius{status,posture,values},
layout{status,density,maxWidth,breakpointLadder}, components{status,idioms[{kind,pattern}]},
motion{status,signature,honoursReducedMotion,durationsMs}, voice{tone,sentenceLength,
structuralLabels}, principles[2–8 sentences], gaps[]`.

Strict validator: unknown keys rejected, every numeric/hex field **ground-checked against
facts** (model may interpret, never invent; `unavailable` is always legal, a made-up value
never is). No navigation-pattern/hero-composition fields exist yet — they will come from
`structure.skeleton` + ContentSpec, not from a DNA schema bump.

## 3. UserBrand — `userbrand/1` (P4 input; pure user data)

```
{ name: string(≤64), tagline?: string(≤140), description: string(≤2000),
  logo: { mode:'upload'|'generated', dataUrl?: safe data-URI, svg?: sanitized,
          alt: string } , paletteHint?: 'any'|'match-brand' }
```
Never serialized to AI Call #1. Enters only: projection for #2, compiler, identity
allow-list (this brand may appear; the reference must not).

## 4. ContentSpec — `contentspec/1` (P4 output; data, never markup)

```
{ schema:'contentspec/1',
  nav: { items:[{label,href:#anchor}], cta?: {label} },
  hero: { eyebrow?, heading(≤90), sub(≤240), ctas:[{label,kind:primary|secondary}], note? },
  sections: [ { id, type: FEATURE_GRID|FEATURE_LIST|STATS|QUOTE|GALLERY|TEXT|CTA,
                title(≤60), lead?, items:[…type-specific ≤8] } ],   // 2–8 sections
  footer: { blurb(≤160), columns?:[{title,links:[{label}]}], fine? } }
```
Strings only; no URLs to anywhere except `#anchors`, no component params beyond the
controlled vocab. Validation: strict schema + identity scan + copy originality check vs.
facts (brand copy can't be in facts because facts holds no prose — so the scan checks
n-gram overlap against quarantined pageOutline server-side). Invalid → **fail honestly**,
no repair (budget rule).

## 5. GeneratedSite — `site/1` (P3 output; deterministic)

```
{ schema:'site/1', html, css, js, assets:[{path:'assets/logo.svg', mime, dataUrl}],
  meta:{ title, description, adjustments:[{role,from,to,reason}] },  // adjustments: contrast nudges, never silent
  generator:'uidconstruct-v1/<ver>',
  identityScan: { passed:true, checked:[…] } }
```
Same (DNA, ContentSpec, UserBrand) ⇒ byte-identical output — this is a test invariant, not
an aspiration. Compiler modules: tokens (DNA→CSS vars), layout (maxWidth/density/
breakpointLadder), components (ContentSpec type → controlled partials), responsive,
interaction (hover/focus/mobile-menu, honours `motion.honoursReducedMotion`). Fonts:
generic stacks + user brand only; no reference family names ever (projection already drops
them). No storage: returned to client, kept in memory, exported as client-side ZIP.

## Endpoints (target)

`POST /api/build` {url, brand} → site (the ≤2-call pipeline) · `POST /api/dna` {url} → DNA
only · existing `/api/deconstruct` untouched (legacy analysis product). Serverless
maxDuration 180s, in-memory caches are instance-local (accepted: cold = one paid-again
stage, correctness unaffected). SSRF guard mandatory on every new fetch (redirect-hop
revalidation — `lib/net.js` already does per-hop).

## Test obligations per phase (extract of P7, binding from now)

P3: determinism (build twice, compare), per-component render, mobile/desktop tokens, reduced-motion.
P4: valid/invalid JSON, brand/domain leakage both directions, oversized output, budget=2 counter.
P5: firewall = throw-and-prove, using the existing `_poisonProjection` seam + findLeaks.
P6: logo determinism (empty/1-char/long/Arabic/Malayalam), upload sanitize (SVG scripts stripped,
      `<img>`-safe data URL), sandbox attributes, ZIP contains exactly site/1 files.
Rule inherited: every guard must be shown to fail (mutation) before it is believed.

## Known accepted items

- `specs/*.html` + `_p0/` audit blobs contain third-party design data (and source metadata)
  — same class as published spec pages; flagged consciously, removal is a product decision.
- `lib/*_old.js` are imported artifacts from the pinned original at f3a543c; harmless,
  unreferenced; delete only with explicit instruction.
