/**
 * X12 trailer validation (SE / GE / IEA counts and control numbers).
 *
 * Works on a ParsedDocument, so it doesn't depend on one segment per line.
 * No vscode dependency - keeps this module unit-testable.
 */

import { ParsedDocument, ParsedSegment, isSegmentTag } from './ediParser';

/**
 * Describes a single trailer mismatch — what the current value is and what it should be.
 */
export interface TrailerError {
    segment: ParsedSegment;
    elemIndex: number;   // 1-based element position in the segment (e.g. SE-01 = 1, SE-02 = 2)
    label: string;       // e.g. "SE-01"
    message: string;
    currentValue: string;
    correctValue: string;
    start: number;       // offset of the element (segment end when the element is missing)
    end: number;
}

/**
 * Compute the correct trailer values for an X12 document.
 * Returns one TrailerError per element that doesn't match expectations.
 *
 * Rules validated:
 *   SE-01  = count of segments from ST to SE inclusive
 *   SE-02  = must match ST-02
 *   GE-01  = count of ST/SE pairs in this functional group
 *   GE-02  = must match GS-06
 *   IEA-01 = count of GS/GE pairs in this interchange
 *   IEA-02 = must match ISA-13
 */
export function analyzeTrailers(doc: ParsedDocument): TrailerError[] {
    const errors: TrailerError[] = [];

    // Interchange state
    let isaControlNumber = '';
    let functionalGroupCount = 0;

    // Functional group state
    let gsControlNumber = '';
    let groupTransactionSetCount = 0;
    let inGroup = false;

    // Transaction set state
    let stControlNumber = '';
    let segmentCount = 0;
    let inTransaction = false;

    const check = (segment: ParsedSegment, elemIndex: number, expected: string, message: (actual: string) => string) => {
        const element = segment.elements[elemIndex - 1];
        const actual = element ? element.value.trim() : '';
        if (actual === expected) return;
        errors.push({
            segment, elemIndex,
            label: `${segment.tag}-${String(elemIndex).padStart(2, '0')}`,
            message: message(actual),
            currentValue: actual,
            correctValue: expected,
            start: element ? element.start : segment.end,
            end: element ? element.end : segment.end
        });
    };

    for (const segment of doc.segments) {
        const getElem = (idx: number) => segment.elements[idx - 1]?.value.trim() ?? '';

        switch (segment.tag) {
            case 'ISA':
                isaControlNumber = getElem(13);
                functionalGroupCount = 0;  // reset for this interchange
                break;

            case 'GS':
                gsControlNumber = getElem(6);
                groupTransactionSetCount = 0;
                inGroup = true;
                break;

            case 'ST':
                stControlNumber = getElem(2);
                segmentCount = 1;   // ST itself is the first segment
                inTransaction = true;
                break;

            case 'SE': {
                if (!inTransaction) break;
                segmentCount++;     // SE is the last segment — count it before comparing
                const expectedCount = String(segmentCount);
                const expectedControl = stControlNumber;
                check(segment, 1, expectedCount, a => `SE-01: Segment count ${a} should be ${expectedCount}`);
                check(segment, 2, expectedControl, a => `SE-02: Control number "${a}" must match ST-02 "${expectedControl}"`);
                groupTransactionSetCount++;
                inTransaction = false;
                break;
            }

            case 'GE': {
                if (!inGroup) break;
                const expectedCount = String(groupTransactionSetCount);
                const expectedControl = gsControlNumber;
                check(segment, 1, expectedCount, a => `GE-01: Transaction set count ${a} should be ${expectedCount}`);
                check(segment, 2, expectedControl, a => `GE-02: Control number "${a}" must match GS-06 "${expectedControl}"`);
                functionalGroupCount++;
                inGroup = false;
                break;
            }

            case 'IEA': {
                const expectedCount = String(functionalGroupCount);
                const expectedControl = isaControlNumber;
                check(segment, 1, expectedCount, a => `IEA-01: Functional group count ${a} should be ${expectedCount}`);
                check(segment, 2, expectedControl, a => `IEA-02: Control number "${a}" must match ISA-13 "${expectedControl}"`);
                break;
            }

            default:
                // Count any segment that falls inside a transaction set (stray text isn't a segment)
                if (inTransaction && isSegmentTag(segment.tag)) segmentCount++;
                break;
        }
    }

    return errors;
}

export interface TextReplacement {
    start: number;
    end: number;
    text: string;
}

/**
 * Build one replacement per trailer segment that has errors. The segment's element
 * list (everything after the tag, before the terminator) is rewritten with the
 * corrected values, so missing elements are added with the right delimiters.
 */
export function buildTrailerFixes(text: string, errors: TrailerError[]): TextReplacement[] {
    const bySegment = new Map<ParsedSegment, TrailerError[]>();
    for (const err of errors) {
        const list = bySegment.get(err.segment) ?? [];
        list.push(err);
        bySegment.set(err.segment, list);
    }

    const fixes: TextReplacement[] = [];
    for (const [segment, segErrors] of bySegment) {
        const values = segment.elements.map(e => text.substring(e.start, e.end));
        for (const err of segErrors) {
            while (values.length < err.elemIndex) values.push('');
            values[err.elemIndex - 1] = err.correctValue;
        }
        const start = segment.start + segment.tag.length;
        const delim = segment.delimiters.element;  // each interchange may declare its own
        fixes.push({ start, end: segment.end, text: delim + values.join(delim) });
    }
    return fixes;
}
