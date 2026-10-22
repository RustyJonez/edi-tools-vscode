/**
 * EDI Document Validator (core)
 *
 * Validates a ParsedDocument against the bundled schemas and returns plain
 * issues with character offsets. commands.ts turns these into VS Code
 * diagnostics. No vscode dependency - keeps this module unit-testable.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ParsedDocument, ParsedSegment, isSegmentTag } from './ediParser';
import { validateElement, validateDateWithFormat, ValidationResult } from './validators';

export interface Issue {
    start: number;   // offset into document text
    end: number;     // exclusive
    message: string;
    severity: 'error' | 'warning';
    code?: string;
}

export interface SchemaSet {
    segments: Record<string, any>;
    elements: Record<string, any>;
    composites: Record<string, any>;
}

export interface LoadedSchema {
    schema: SchemaSet;
    version: string;           // version actually loaded
    requestedVersion: string;  // version detected from the document
    fellBack: boolean;         // true when requestedVersion wasn't available
}

interface ElementDef {
    position: string;
    name?: string;
    requirement?: string;
    type: string;
    /** Set when the schema flattened a composite into the segment's element list */
    inlineComposite?: { components: Array<{ elementId: string; requirement?: string }> };
}

// ---------------------------------------------------------------------------
// Version detection & schema loading
// ---------------------------------------------------------------------------

const X12_VERSION_MAPPINGS: Record<string, string> = {
    '002000': '002040',
    '003000': '003010',
    '004000': '004010',
    '005000': '005010',
    '006000': '006010',
    '007000': '007010',
    '008000': '008010',
};

/** Sortable number for a version directory name: 004010 -> 4010, d96a -> 1996.0, d01b -> 2001.5 */
function versionRank(standard: 'x12' | 'edifact', version: string): number {
    if (standard === 'x12') return parseInt(version, 10);
    const m = /^d(\d{2})([ab])$/i.exec(version);
    if (!m) return NaN;
    const yy = parseInt(m[1], 10);
    return (yy < 90 ? 2000 + yy : 1900 + yy) + (m[2].toLowerCase() === 'b' ? 0.5 : 0);
}

/** Closest bundled version to the requested one (ties go to the older version). */
function nearestVersion(base: string, standard: 'x12' | 'edifact', requested: string): string | undefined {
    const target = versionRank(standard, requested);
    const available = fs.existsSync(base)
        ? fs.readdirSync(base).filter(v => !isNaN(versionRank(standard, v)))
        : [];
    if (isNaN(target)) {
        const preferred = standard === 'x12' ? '004010' : 'd96a';
        return available.includes(preferred) ? preferred : available[0];
    }
    return available.sort((a, b) =>
        Math.abs(versionRank(standard, a) - target) - Math.abs(versionRank(standard, b) - target)
        || versionRank(standard, a) - versionRank(standard, b))[0];
}

const DEFAULT_VERSION = { x12: '004010', edifact: 'd96a' };

/** ISA-12 (00401) -> 004010 */
function isaVersion(isa: ParsedSegment | undefined): string | undefined {
    const isa12 = isa?.elements[11]?.value.trim() ?? '';
    return /^\d{5}$/.test(isa12) ? X12_VERSION_MAPPINGS[isa12 + '0'] ?? isa12 + '0' : undefined;
}

/** GS-08 carries the full version (e.g. 004010VICS, 005010X222A1) */
function gsVersion(gs: ParsedSegment | undefined): string | undefined {
    const gs08 = gs?.elements[7]?.value.trim() ?? '';
    return /^\d{6}/.test(gs08) ? X12_VERSION_MAPPINGS[gs08.substring(0, 6)] ?? gs08.substring(0, 6) : undefined;
}

/** UNH S009 (ORDERS:D:96A:UN) -> d96a */
function unhVersion(unh: ParsedSegment | undefined): string | undefined {
    const comps = unh?.elements[1]?.repetitions[0]?.components.map(c => c.value) ?? [];
    return comps[1]?.toUpperCase() === 'D' && /^\d{2}[AB]$/i.test(comps[2] ?? '')
        ? 'd' + comps[2].toLowerCase()
        : undefined;
}

/** Detect the document's (first) schema version: GS-08 / ISA-12 for X12, UNH S009 for EDIFACT. */
export function detectVersion(doc: ParsedDocument): string {
    const find = (tag: string) => doc.segments.find(s => s.tag === tag);
    return (doc.standard === 'edifact'
        ? unhVersion(find('UNH'))
        : gsVersion(find('GS')) ?? isaVersion(find('ISA'))) ?? DEFAULT_VERSION[doc.standard];
}

export interface VersionSection {
    version: string;
    segments: ParsedSegment[];
}

/**
 * Split the document into runs of segments that share a schema version. A file can hold
 * several interchanges / groups / messages of different versions:
 *   X12:     ISA/IEA (and anything outside a group) use ISA-12, GS..GE use that group's GS-08
 *   EDIFACT: UNH..UNT use that message's S009, envelope segments use the first message's
 */
export function versionSections(doc: ParsedDocument): VersionSection[] {
    const sections: VersionSection[] = [];
    const push = (version: string, segment: ParsedSegment) => {
        const last = sections[sections.length - 1];
        if (last && last.version === version) last.segments.push(segment);
        else sections.push({ version, segments: [segment] });
    };

    if (doc.standard === 'edifact') {
        const envelope = unhVersion(doc.segments.find(s => s.tag === 'UNH')) ?? DEFAULT_VERSION.edifact;
        let message: string | undefined;
        for (const s of doc.segments) {
            if (s.tag === 'UNH') message = unhVersion(s) ?? envelope;
            push(message ?? envelope, s);
            if (s.tag === 'UNT') message = undefined;
        }
        return sections;
    }

    let interchange = DEFAULT_VERSION.x12;
    let group: string | undefined;
    for (const s of doc.segments) {
        if (s.tag === 'ISA') interchange = isaVersion(s) ?? DEFAULT_VERSION.x12;
        if (s.tag === 'GS') group = gsVersion(s) ?? interchange;
        push(group ?? interchange, s);
        if (s.tag === 'GE') group = undefined;
    }
    return sections;
}

function readJson(file: string): Record<string, any> {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
}

export function loadSchema(extensionPath: string, standard: 'x12' | 'edifact', requestedVersion: string): LoadedSchema {
    const base = path.join(extensionPath, 'schemas', standard);
    let version = requestedVersion;
    if (!fs.existsSync(path.join(base, version))) {
        version = nearestVersion(base, standard, requestedVersion) ?? requestedVersion;
    }
    const dir = path.join(base, version);
    return {
        schema: {
            segments: readJson(path.join(dir, 'segments.json')),
            elements: readJson(path.join(dir, 'elements.json')),
            composites: readJson(path.join(dir, 'composites.json')),
        },
        version,
        requestedVersion,
        fellBack: version !== requestedVersion,
    };
}

// ---------------------------------------------------------------------------
// Segment element definitions
// ---------------------------------------------------------------------------

/**
 * Return the segment's element definitions indexed by element position (index 0 = element 01).
 *
 * The bundled schemas sometimes list composite components inline in the segment's element list:
 *
 *  - EDIFACT d98b/d01b/d03a/d21a: the composite entry is followed by its components 2..n,
 *    e.g. DTM: 010:C507 020:2380 030:2379. Those trailing component entries are dropped.
 *  - X12 AK4, IK4, EXI, AWD, CSF, SV5, TBA, UIT: the composite at position 01 is replaced by
 *    its components, followed by a position reset back to 02 for the real elements,
 *    e.g. AK4: 01:722 02:1528 | 02:725 03:723 04:724. Those are folded back into one composite.
 */
export function resolveSegmentElements(segmentInfo: any, composites: Record<string, any>): ElementDef[] {
    const raw: ElementDef[] = segmentInfo?.elements ?? [];

    const entries: ElementDef[] = [];
    for (let i = 0; i < raw.length; i++) {
        entries.push(raw[i]);
        // Inlined components carry their component position (020, 030...), which tells them
        // apart from a following real element of the same type (e.g. X12 SVD: C003 then 04:234)
        const components: any[] = composites[raw[i].type]?.components ?? [];
        const isInlined = (e: ElementDef | undefined, c: number) =>
            e !== undefined && e.type === components[c].elementId && e.position === components[c].position;
        for (let c = 1; c < components.length && isInlined(raw[i + 1], c); c++) i++;
    }

    const resetAt = entries.findIndex((e, i) =>
        i > 0 && parseInt(e.position, 10) <= parseInt(entries[i - 1].position, 10));
    if (resetAt < 0 || !/^\d{2}$/.test(entries[0].position)) return entries;

    const run = entries.slice(0, resetAt);
    const runTypes = run.map(e => e.type).join(',');
    const matching = Object.keys(composites).find(k =>
        (composites[k].components ?? []).map((c: any) => c.elementId).join(',') === runTypes);

    const defs: ElementDef[] = [{
        position: '01',
        name: matching ? composites[matching].name : run[0].name,
        requirement: run[0].requirement,
        type: matching ?? run[0].type,
        inlineComposite: matching ? undefined : {
            components: run.map(e => ({ elementId: e.type, requirement: e.requirement }))
        }
    }];
    for (const e of entries.slice(resetAt)) {
        const idx = parseInt(e.position, 10) - 1;
        if (idx > 0 && !defs[idx]) defs[idx] = e;
    }
    return defs;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function toIssue(start: number, end: number, label: string, v: ValidationResult): Issue {
    return { start, end, message: `${label}: ${v.message}`, severity: v.severity, code: v.errorType };
}

function schemaFor(detail: any, elementNumber: string) {
    return {
        dataType: detail.dataType || 'AN',
        minLength: detail.minLength || 0,
        maxLength: detail.maxLength || 999,
        codes: detail.codes,
        elementNumber
    };
}

/** Validate a whole document against one schema (see versionSections for mixed-version files). */
export function validateParsedDocument(doc: ParsedDocument, schema: SchemaSet): Issue[] {
    return validateSegments(doc.segments, schema);
}

/** Load each version's schema once and validate every section against its own version. */
export function validateByVersion(
    doc: ParsedDocument,
    load: (version: string) => LoadedSchema
): { issues: Issue[]; loaded: LoadedSchema[] } {
    const issues: Issue[] = [];
    const loaded = new Map<string, LoadedSchema>();
    for (const section of versionSections(doc)) {
        let l = loaded.get(section.version);
        if (!l) {
            l = load(section.version);
            loaded.set(section.version, l);
        }
        issues.push(...validateSegments(section.segments, l.schema));
    }
    return { issues, loaded: [...loaded.values()] };
}

export function validateSegments(segments: ParsedSegment[], schema: SchemaSet): Issue[] {
    const issues: Issue[] = [];
    const defsCache = new Map<string, ElementDef[]>();
    const dateFormatCodes = schema.elements['2379']?.codes;

    for (const segment of segments) {
        if (!isSegmentTag(segment.tag)) {
            // e.g. notes typed after a terminator: "SAC*A*...~   <-Advertising"
            const snippet = segment.tag.replace(/\s+/g, ' ').substring(0, 30);
            issues.push({
                start: segment.start, end: segment.start + segment.tag.length,
                message: `Unexpected text "${snippet}" - not an EDI segment`,
                severity: 'warning', code: 'notSegment'
            });
            continue;
        }

        if (segment.missingTerminator) {
            const term = JSON.stringify(segment.delimiters.segment);
            issues.push({
                start: segment.end, end: segment.end,
                message: `${segment.tag}: Missing segment terminator ${term} before line break`,
                severity: 'error', code: 'terminator'
            });
        }

        const segmentInfo = schema.segments[segment.tag];
        if (!segmentInfo || !segmentInfo.elements) continue;

        let defs = defsCache.get(segment.tag);
        if (!defs) {
            defs = resolveSegmentElements(segmentInfo, schema.composites);
            defsCache.set(segment.tag, defs);
        }

        segment.elements.forEach((element, i) => {
            const def = defs![i];
            if (!def) return;
            const elemLabel = `${segment.tag}-${String(i + 1).padStart(2, '0')}`;

            // Use length === 0 (not trim) so that space-filled fields like ISA-02/04
            // (which contain spaces when the qualifier is "00") are not falsely flagged.
            if (element.value.length === 0) {
                if (def.requirement === 'M') {
                    issues.push({
                        start: element.start, end: Math.max(element.end, element.start + 1),
                        message: `${elemLabel}: Mandatory element blank`, severity: 'error', code: 'mandatory'
                    });
                }
                return;
            }

            const compositeInfo = def.inlineComposite ?? schema.composites[def.type] ?? null;
            const elementDetail = schema.elements[def.type];

            for (const rep of element.repetitions) {
                if (!rep.value.trim()) continue;

                if (compositeInfo) {
                    const compDefs: any[] = compositeInfo.components ?? [];
                    if (compDefs.length === 0) continue;

                    if (rep.components.length === 1) {
                        // Single component - validate against first component's schema
                        const detail = schema.elements[compDefs[0].elementId];
                        if (detail) {
                            const v = validateElement(rep.value, schemaFor(detail, compDefs[0].elementId));
                            if (!v.isValid) issues.push(toIssue(rep.start, rep.end, elemLabel, v));
                        }
                        continue;
                    }

                    // Date/time composite (EDIFACT C507): component 3 is the format qualifier
                    const isDateComposite = def.type === 'C507';
                    const dateFormat = isDateComposite ? rep.components[2]?.value : undefined;

                    rep.components.forEach((comp, c) => {
                        const compDef = compDefs[c];
                        if (!compDef) return;
                        const compLabel = `${elemLabel}-${String(c + 1).padStart(2, '0')}`;

                        if (!comp.value.trim()) {
                            if (compDef.requirement === 'M') {
                                issues.push({
                                    start: comp.start, end: Math.max(comp.end, comp.start + 1),
                                    message: `${compLabel}: Mandatory component blank`, severity: 'error', code: 'mandatory'
                                });
                            }
                            return;
                        }

                        const detail = schema.elements[compDef.elementId];
                        if (!detail) return;
                        const v = isDateComposite && c === 1 && dateFormat
                            ? validateDateWithFormat(comp.value, dateFormat, dateFormatCodes)
                            : validateElement(comp.value, schemaFor(detail, compDef.elementId));
                        if (!v.isValid) issues.push(toIssue(comp.start, comp.end, compLabel, v));
                    });
                } else if (elementDetail) {
                    const v = validateElement(rep.value, schemaFor(elementDetail, def.type));
                    if (!v.isValid) issues.push(toIssue(rep.start, rep.end, elemLabel, v));
                }
            }
        });

        // Trailing mandatory elements that are missing entirely
        for (let i = segment.elements.length; i < defs.length; i++) {
            if (defs[i]?.requirement === 'M') {
                issues.push({
                    start: segment.end, end: segment.end,
                    message: `${segment.tag}-${String(i + 1).padStart(2, '0')}: Mandatory element missing`,
                    severity: 'error', code: 'mandatory'
                });
            }
        }
    }

    return issues;
}
