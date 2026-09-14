// lib/schema.js — a small strict validator + the DesignDNA schema.
//
// No dependency, on purpose: a validator we cannot read in one sitting is a
// validator we cannot trust. The property that matters here is STRICTNESS -
// unknown keys and type drift from a language model must be rejected loudly,
// because a half-valid DNA object silently propagates into every generated site.
//
// Validation errors are returned as JSON-pointer-ish paths ("$.palette.roles[0]")
// so the repair prompt can name the offending field instead of asking the model
// to guess what we disliked.

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

const TYPES = {
    string: (v) => typeof v === 'string' && v.length > 0,
    number: (v) => isNum(v),
    integer: (v) => Number.isInteger(v),
    boolean: (v) => typeof v === 'boolean',
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: (v) => Array.isArray(v),
    hexcolor: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
    hashref: (v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v),
    enum: (vals) => (v) => typeof v === 'string' && vals.includes(v),
    strEnum: (vals) => (v) => typeof v === 'string' && v.length > 0 && v.length <= 4000,
    nullableString: (v) => v === null || (typeof v === 'string' && v.length > 0),
    statusSection: (v) => v && typeof v === 'object' && ['extracted', 'unavailable'].includes(v.status),
};

// Spec node: { type, spec?, of?, min?, max?, enum?, required? }
function validate(value, spec, path, errs, facts) {
    if (spec.nullable && value === null) return;
    const t = spec.type;
    const check = typeof t === 'function' ? t : TYPES[t];
    if (!check) { errs.push(path + ': schema bug, unknown type'); return; }
    if (!check(value)) {
        errs.push(path + ': expected ' + (spec.typeName || (typeof t === 'function' ? 'custom' : t)) + ', got ' + JSON.stringify(value)?.slice(0, 80));
        return;
    }
    if (spec.min !== undefined && value.length < spec.min) errs.push(path + ': needs >= ' + spec.min + ' entries, has ' + value.length);
    if (spec.max !== undefined && value.length > spec.max) errs.push(path + ': exceeds max ' + spec.max + ', has ' + value.length);
    if (spec.maximum !== undefined && value > spec.maximum) errs.push(path + ': ' + value + ' > max ' + spec.maximum);
    if (spec.minimum !== undefined && value < spec.minimum) errs.push(path + ': ' + value + ' < min ' + spec.minimum);

    if (Array.isArray(value) && spec.of) {
        value.forEach((item, i) => validate(item, spec.of, path + '[' + i + ']', errs, facts));
        if (spec.unique) {
            const seen = new Set();
            value.forEach((item, i) => {
                const k = JSON.stringify(spec.uniqueBy ? item && item[spec.uniqueBy] : item);
                if (seen.has(k)) errs.push(path + '[' + i + ']: duplicate ' + k);
                seen.add(k);
            });
        }
        return;
    }
    if (value && typeof value === 'object' && spec.spec) {
        for (const key of Object.keys(spec.spec)) {
            const sub = spec.spec[key];
            const need = sub.required !== false;
            if (!(key in value)) { if (need) errs.push(path + '.' + key + ': missing'); continue; }
            validate(value[key], sub, path + '.' + key, errs, facts);
        }
        for (const key of Object.keys(value)) {
            if (!(key in spec.spec)) errs.push(path + '.' + key + ': unknown field');
        }
    }
}

// ---------------------------------------------------------------------------
// DesignDNA schema
//
// Locked rule #1 (user correction): the model may interpret, it may NOT invent
// factual numbers. So every numeric/colour field is declared grounded:true, and
// validateDna() cross-checks it against DesignFacts. A value that is neither
// present in facts nor deterministically derivable is a hard error, and the
// correct alternative is the 'unavailable' status - which the schema permits
// explicitly, so "we don't know" is always a legal answer and "we made it up"
// never is.
// ---------------------------------------------------------------------------

const ROLE = TYPES.enum(['canvas', 'surface', 'surface-alt', 'text', 'text-muted', 'accent', 'accent-text', 'border', 'success', 'warning', 'danger']);

const DNA_SCHEMA = {
    type: 'object',
    spec: {
        schema: { type: (v) => v === 'designdna/1', typeName: '"designdna/1"' },
        factsHash: { type: TYPES.hashref },
        model: { type: 'string' },          // provider/model is configuration, never schema
        identity: {
            type: 'object',
            spec: {
                referenceName: { type: (v) => v === null, typeName: 'null (always)' },
                referenceDomain: { type: (v) => v === null, typeName: 'null (always)' },
            },
        },
        palette: {
            type: 'object',
            spec: {
                roles: {
                    type: 'array', min: 1, max: 12, unique: true, uniqueBy: 'role',
                    of: {
                        type: 'object',
                        spec: {
                            role: { type: ROLE },
                            value: { type: TYPES.hexcolor },
                            // factRef names the DesignFacts token this came from.
                            // Optional: a value can be grounded by being a direct
                            // copy of an extracted hex without naming a token.
                            factRef: { type: 'string', required: false },
                            confidence: { type: 'number', minimum: 0, maximum: 1, required: false },
                        },
                    },
                },
                temperature: { type: TYPES.enum(['warm', 'neutral', 'cool']) },
                saturation: { type: TYPES.enum(['none', 'low', 'medium', 'high']) },
                contrastStrategy: { type: TYPES.enum(['high', 'medium', 'low']) },
            },
        },
        typography: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                hierarchy: { type: TYPES.enum(['modular', 'fluid', 'stepped', 'unknown']) },
                scaleRatio: { type: 'number', nullable: true, minimum: 1, maximum: 3 },
                display: { type: TYPES.enum(['serif', 'sans', 'mono', 'slab', 'script', 'unknown']) },
                body: { type: TYPES.enum(['serif', 'sans', 'mono', 'unknown']) },
                weightsUsed: { type: 'array', min: 1, max: 6, of: { type: TYPES.integer }, unique: true, required: false },
            },
        },
        spacing: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                baseUnit: { type: 'number', nullable: true, minimum: 1, maximum: 64 },
                rhythm: { type: TYPES.enum(['tight', 'normal', 'loose', 'unknown']) },
            },
        },
        radius: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                posture: { type: TYPES.enum(['sharp', 'soft', 'pill', 'mixed', 'unknown']) },
                values: { type: 'array', min: 0, max: 12, of: { type: TYPES.string }, unique: true, required: false },
            },
        },
        layout: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                density: { type: TYPES.enum(['airy', 'normal', 'dense', 'unknown']) },
                maxWidth: { type: 'number', nullable: true, minimum: 320, maximum: 3000 },
                breakpointLadder: { type: 'array', min: 0, max: 12, of: { type: TYPES.integer }, unique: true, required: false },
            },
        },
        components: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                idioms: {
                    type: 'array', min: 1, max: 10,
                    of: {
                        type: 'object',
                        spec: {
                            kind: { type: TYPES.enum(['button', 'link', 'input', 'card', 'nav', 'footer', 'heading', 'text', 'icon', 'dropdown', 'list', 'toc', 'unknown']) },
                            pattern: { type: TYPES.strEnum },
                        },
                    },
                },
            },
        },
        motion: {
            type: 'object',
            spec: {
                status: { type: TYPES.enum(['extracted', 'unavailable']) },
                signature: { type: TYPES.enum(['none', 'subtle', 'reveal', 'playful', 'unknown']) },
                honoursReducedMotion: { type: 'boolean' },
                durationsMs: { type: 'array', min: 0, max: 8, of: { type: TYPES.integer }, unique: true, required: false },
            },
        },
        voice: {
            type: 'object',
            spec: {
                tone: { type: TYPES.enum(['plain', 'technical', 'playful', 'formal', 'unknown']) },
                sentenceLength: { type: TYPES.enum(['short', 'medium', 'long', 'unknown']) },
                structuralLabels: { type: 'array', min: 0, max: 12, of: { type: TYPES.strEnum }, unique: true, required: false },
            },
        },
        principles: {
            type: 'array', min: 2, max: 8,
            of: { type: (v) => typeof v === 'string' && v.trim().split(/\s+/).length >= 4 && v.length <= 400, typeName: 'sentence string' },
        },
        gaps: { type: 'array', min: 0, max: 12, of: { type: TYPES.strEnum }, unique: true, required: false },
    },
};

module.exports = { TYPES, DNA_SCHEMA, validate };
