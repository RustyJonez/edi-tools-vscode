/**
 * EDI Document Parser
 *
 * Splits an X12 or EDIFACT document into segments, elements, repetitions and
 * components using the delimiters declared in the envelope (ISA / UNA), not
 * line breaks. Every piece keeps its character offsets into the original text
 * so callers can map results back to editor ranges.
 *
 * No vscode dependency - keeps this module unit-testable with plain Node.
 */

export interface Delimiters {
    element: string;
    component: string;
    segment: string;
    repetition?: string;  // X12 ISA-11 (00402+), EDIFACT UNA-7 (syntax 4)
    release?: string;     // EDIFACT only (usually '?')
    decimal?: string;     // EDIFACT only (usually '.')
}

export interface ParsedComponent {
    value: string;   // release characters removed
    start: number;   // offset into document text
    end: number;     // exclusive
}

export interface ParsedRepetition extends ParsedComponent {
    components: ParsedComponent[];
}

export interface ParsedElement extends ParsedComponent {
    repetitions: ParsedRepetition[];
}

export interface ParsedSegment {
    tag: string;
    start: number;              // offset of the first character of the tag
    end: number;                // offset of the terminator (or end of text)
    elements: ParsedElement[];  // elements[0] is element 01
    delimiters: Delimiters;     // delimiters in effect (each X12 interchange can declare its own)
    missingTerminator?: boolean; // segment ended at a line break instead of a terminator
}

export interface ParsedDocument {
    standard: 'x12' | 'edifact';
    delimiters: Delimiters;
    segments: ParsedSegment[];
}

export type ParseResult = ParsedDocument | { error: string };

/** True for a well-formed segment tag (2-3 chars, letter first). Anything else is stray text. */
export function isSegmentTag(tag: string): boolean {
    return /^[A-Z][A-Z0-9]{1,2}$/.test(tag);
}

/** True when the text looks like EDIFACT (UNA / UNB / UNH envelope). */
export function looksLikeEdifact(text: string): boolean {
    const t = text.replace(/^﻿?\s*/, '');
    return t.startsWith('UNA') || t.startsWith('UNB') || /(^|['\n])UNH\+/.test(t);
}

/** True when the text starts with an X12 ISA envelope. */
export function looksLikeX12(text: string): boolean {
    return /^﻿?\s*ISA/.test(text);
}

export function parseDocument(text: string, standard?: 'x12' | 'edifact'): ParseResult {
    const std = standard ?? (looksLikeX12(text) ? 'x12' : looksLikeEdifact(text) ? 'edifact' : undefined);
    if (std === 'x12') return parseX12(text);
    if (std === 'edifact') return parseEdifact(text);
    return { error: 'Not an EDI document (no ISA or UNB/UNH envelope found)' };
}

// ---------------------------------------------------------------------------
// X12
// ---------------------------------------------------------------------------

/**
 * Read delimiters from the ISA segment: element = char after "ISA",
 * component = ISA-16, segment terminator = char after ISA-16,
 * repetition = ISA-11 when ISA-12 is 00402 or later and ISA-11 is not alphanumeric.
 */
export function readX12Delimiters(text: string, isaStart: number): Delimiters | undefined {
    const element = text.charAt(isaStart + 3);
    if (!element || /[A-Za-z0-9\s]/.test(element)) return undefined;

    const delimPositions: number[] = [];
    for (let i = isaStart + 3; i < text.length && delimPositions.length < 16; i++) {
        if (text.charAt(i) === element) delimPositions.push(i);
    }
    if (delimPositions.length < 16) return undefined;

    const component = text.charAt(delimPositions[15] + 1);
    const segment = text.charAt(delimPositions[15] + 2);
    if (!component || !segment) return undefined;

    // delimPositions[n] precedes ISA element n+1
    const isa11 = text.substring(delimPositions[10] + 1, delimPositions[11]);
    const isa12 = text.substring(delimPositions[11] + 1, delimPositions[12]);
    let repetition: string | undefined;
    if (isa11.length === 1 && !/[A-Za-z0-9 ]/.test(isa11) && parseInt(isa12, 10) >= 402) {
        repetition = isa11;
    }

    return { element, component, segment, repetition };
}

function parseX12(text: string): ParseResult {
    const isaStart = text.search(/ISA/);
    if (isaStart < 0 || text.substring(0, isaStart).replace(/^﻿/, '').trim() !== '') {
        return { error: 'X12 document must start with an ISA segment' };
    }
    const delimiters = readX12Delimiters(text, isaStart);
    if (!delimiters) {
        return { error: 'Could not read delimiters from the ISA segment (expected 16 elements)' };
    }
    return { standard: 'x12', delimiters, segments: splitSegments(text, isaStart, delimiters, 'x12') };
}

// ---------------------------------------------------------------------------
// EDIFACT
// ---------------------------------------------------------------------------

const EDIFACT_DEFAULTS: Delimiters = {
    component: ':', element: '+', decimal: '.', release: '?', segment: "'"
};

function parseEdifact(text: string): ParseResult {
    let pos = text.search(/\S/);
    if (pos < 0) return { error: 'Empty document' };
    if (text.charCodeAt(pos) === 0xFEFF) pos++;

    let delimiters: Delimiters = { ...EDIFACT_DEFAULTS };
    if (text.startsWith('UNA', pos)) {
        const una = text.substring(pos + 3, pos + 9);
        if (una.length < 6) return { error: 'UNA service string advice is incomplete' };
        delimiters = {
            component: una[0],
            element: una[1],
            decimal: una[2],
            release: una[3] === ' ' ? undefined : una[3],
            repetition: una[4] === ' ' ? undefined : una[4],
            segment: una[5]
        };
        pos += 9;
    }
    return { standard: 'edifact', delimiters, segments: splitSegments(text, pos, delimiters, 'edifact') };
}

// ---------------------------------------------------------------------------
// Shared splitting
// ---------------------------------------------------------------------------

function isLineBreak(ch: string): boolean {
    return ch === '\r' || ch === '\n';
}

/** Find the next unescaped occurrence of any of `targets` in [from, to). */
function nextDelimiter(text: string, from: number, to: number, targets: string[], release?: string): number {
    for (let i = from; i < to; i++) {
        const ch = text.charAt(i);
        if (release && ch === release) { i++; continue; }
        if (targets.includes(ch)) return i;
    }
    return to;
}

/** Remove release characters and any CR/LF (never part of the data - e.g. fixed-width wrapped files). */
function unescape(raw: string, release?: string): string {
    if (/[\r\n]/.test(raw)) raw = raw.replace(/[\r\n]/g, '');
    if (!release || !raw.includes(release)) return raw;
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        if (raw.charAt(i) === release && i + 1 < raw.length) i++;
        out += raw.charAt(i);
    }
    return out;
}

function splitRange(text: string, start: number, end: number, delim: string | undefined, release?: string): Array<[number, number]> {
    const parts: Array<[number, number]> = [];
    if (!delim) return [[start, end]];
    let s = start;
    for (;;) {
        const d = nextDelimiter(text, s, end, [delim], release);
        parts.push([s, d]);
        if (d >= end) break;
        s = d + 1;
    }
    return parts;
}

/**
 * True when the file is wrapped at a fixed record width (every line but the last the
 * same length), so line breaks inside segments are expected and not missing terminators.
 */
function isFixedWidthWrapped(text: string, segTerm: string): boolean {
    if (isLineBreak(segTerm)) return false;
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length < 3) return false;
    const width = lines[0].length;
    return width > 0 && lines.slice(0, -1).every(l => l.length === width);
}

/**
 * Within [from, to), find a line break that is immediately followed by what looks like the
 * start of another segment (tag + element delimiter). That means the terminator before the
 * line break is missing - e.g. a hand-edited file. Returns the line break offset, or -1.
 */
function findMissingTerminator(text: string, from: number, to: number, delims: Delimiters): number {
    for (let i = from; i < to; i++) {
        const ch = text.charAt(i);
        if (delims.release && ch === delims.release) { i++; continue; }
        if (!isLineBreak(ch)) continue;
        let j = i;
        while (j < to && isLineBreak(text.charAt(j))) j++;
        let k = j;
        while (k < to && k < j + 3 && /[A-Z0-9]/.test(text.charAt(k))) k++;
        if (k - j >= 2 && /[A-Z]/.test(text.charAt(j)) && text.charAt(k) === delims.element) return i;
        i = j - 1;
    }
    return -1;
}

function splitSegments(text: string, from: number, initial: Delimiters, standard: 'x12' | 'edifact'): ParsedSegment[] {
    const segments: ParsedSegment[] = [];
    const wrapped = isFixedWidthWrapped(text, initial.segment);
    let delims = initial;
    let pos = from;

    while (pos < text.length) {
        // Skip whitespace / line breaks between segments
        while (pos < text.length && /\s/.test(text.charAt(pos))) pos++;
        if (pos >= text.length) break;

        // Each X12 interchange declares its own delimiters
        if (standard === 'x12' && pos !== from && text.startsWith('ISA', pos)) {
            delims = readX12Delimiters(text, pos) ?? delims;
        }

        // When the terminator is '\n', a preceding '\r' is trimmed in parseSegment
        let end = nextDelimiter(text, pos, text.length, [delims.segment], delims.release);
        let missingTerminator = false;
        if (!wrapped && !isLineBreak(delims.segment)) {
            const brk = findMissingTerminator(text, pos, end, delims);
            if (brk >= 0) {
                end = brk;
                missingTerminator = true;
            }
        }

        const segment = parseSegment(text, pos, end, delims);
        if (segment) {
            if (missingTerminator) segment.missingTerminator = true;
            segments.push(segment);
        }
        pos = missingTerminator ? end : end + 1;
    }
    return segments;
}

function parseSegment(text: string, start: number, end: number, delims: Delimiters): ParsedSegment | undefined {
    // Trim trailing line-break characters that sit inside the segment span
    let segEnd = end;
    while (segEnd > start && isLineBreak(text.charAt(segEnd - 1))) segEnd--;
    if (segEnd <= start) return undefined;

    const fields = splitRange(text, start, segEnd, delims.element, delims.release);
    const [tagStart, tagEnd] = fields[0];
    const tag = text.substring(tagStart, tagEnd).trim();

    // ISA carries the delimiters themselves - never split its elements further
    const isEnvelope = tag === 'ISA';

    const elements: ParsedElement[] = fields.slice(1).map(([s, e]) => {
        const reps = isEnvelope
            ? [[s, e] as [number, number]]
            : splitRange(text, s, e, delims.repetition, delims.release);
        const repetitions: ParsedRepetition[] = reps.map(([rs, re]) => {
            const comps = isEnvelope
                ? [[rs, re] as [number, number]]
                : splitRange(text, rs, re, delims.component, delims.release);
            return {
                value: unescape(text.substring(rs, re), delims.release),
                start: rs,
                end: re,
                components: comps.map(([cs, ce]) => ({
                    value: unescape(text.substring(cs, ce), delims.release),
                    start: cs,
                    end: ce
                }))
            };
        });
        return {
            value: unescape(text.substring(s, e), delims.release),
            start: s,
            end: e,
            repetitions
        };
    });

    return { tag, start, end: segEnd, elements, delimiters: delims };
}
