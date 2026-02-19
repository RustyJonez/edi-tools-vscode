import * as vscode from 'vscode';

/**
 * Describes a single trailer mismatch — what the current value is and what it should be.
 */
export interface TrailerError {
    lineNum: number;
    elemIndex: number;   // 1-based element position in the segment (e.g. SE-01 = 1, SE-02 = 2)
    label: string;       // e.g. "SE-01"
    message: string;
    currentValue: string;
    correctValue: string;
}

/** Strip segment terminator characters and trim whitespace from a raw element string. */
function stripTerminator(raw: string): string {
    return raw.replace(/[~'\r\n]+$/, '').trim();
}

/**
 * Parse an X12 document and compute the correct trailer values.
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
export function analyzeTrailers(
    document: vscode.TextDocument,
    elemDelim: string
): TrailerError[] {
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

    for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
        const lineText = document.lineAt(lineNum).text;
        if (!lineText.trim()) continue;

        // Must start with a valid segment code followed by the element delimiter
        const delimEscaped = elemDelim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const codeMatch = lineText.match(new RegExp(`^([A-Z][A-Z0-9]{1,2})(?=${delimEscaped})`));
        if (!codeMatch) continue;

        const code = codeMatch[1];
        const parts = lineText.split(elemDelim);

        // Return the value of element at idx, stripping the segment terminator if it's the last.
        const getElem = (idx: number): string => {
            if (idx >= parts.length) return '';
            return idx === parts.length - 1
                ? stripTerminator(parts[idx])
                : parts[idx].trim();
        };

        switch (code) {
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

                const seExpectedCount = String(segmentCount);
                const seExpectedControl = stControlNumber;
                const seActualCount = getElem(1);
                const seActualControl = getElem(2);

                if (seActualCount !== seExpectedCount) {
                    errors.push({
                        lineNum, elemIndex: 1, label: 'SE-01',
                        message: `SE-01: Segment count ${seActualCount} should be ${seExpectedCount}`,
                        currentValue: seActualCount, correctValue: seExpectedCount
                    });
                }
                if (seActualControl !== seExpectedControl) {
                    errors.push({
                        lineNum, elemIndex: 2, label: 'SE-02',
                        message: `SE-02: Control number "${seActualControl}" must match ST-02 "${seExpectedControl}"`,
                        currentValue: seActualControl, correctValue: seExpectedControl
                    });
                }

                groupTransactionSetCount++;
                inTransaction = false;
                break;
            }

            case 'GE': {
                if (!inGroup) break;

                const geExpectedCount = String(groupTransactionSetCount);
                const geExpectedControl = gsControlNumber;
                const geActualCount = getElem(1);
                const geActualControl = getElem(2);

                if (geActualCount !== geExpectedCount) {
                    errors.push({
                        lineNum, elemIndex: 1, label: 'GE-01',
                        message: `GE-01: Transaction set count ${geActualCount} should be ${geExpectedCount}`,
                        currentValue: geActualCount, correctValue: geExpectedCount
                    });
                }
                if (geActualControl !== geExpectedControl) {
                    errors.push({
                        lineNum, elemIndex: 2, label: 'GE-02',
                        message: `GE-02: Control number "${geActualControl}" must match GS-06 "${geExpectedControl}"`,
                        currentValue: geActualControl, correctValue: geExpectedControl
                    });
                }

                functionalGroupCount++;
                inGroup = false;
                break;
            }

            case 'IEA': {
                const ieaExpectedCount = String(functionalGroupCount);
                const ieaExpectedControl = isaControlNumber;
                const ieaActualCount = getElem(1);
                const ieaActualControl = getElem(2);

                if (ieaActualCount !== ieaExpectedCount) {
                    errors.push({
                        lineNum, elemIndex: 1, label: 'IEA-01',
                        message: `IEA-01: Functional group count ${ieaActualCount} should be ${ieaExpectedCount}`,
                        currentValue: ieaActualCount, correctValue: ieaExpectedCount
                    });
                }
                if (ieaActualControl !== ieaExpectedControl) {
                    errors.push({
                        lineNum, elemIndex: 2, label: 'IEA-02',
                        message: `IEA-02: Control number "${ieaActualControl}" must match ISA-13 "${ieaExpectedControl}"`,
                        currentValue: ieaActualControl, correctValue: ieaExpectedControl
                    });
                }
                break;
            }

            default:
                // Count any segment that falls inside a transaction set
                if (inTransaction) {
                    segmentCount++;
                }
                break;
        }
    }

    return errors;
}

/**
 * Compute the character range of a specific element within a segment line.
 * elemIndex is 1-based (SE-01 = 1, SE-02 = 2).
 */
export function getTrailerElementRange(
    lineText: string,
    elemIndex: number,
    elemDelim: string,
    lineNum: number
): vscode.Range {
    const parts = lineText.split(elemDelim);
    let charPos = 0;
    for (let i = 0; i < elemIndex; i++) {
        charPos += parts[i].length + 1; // +1 for the delimiter
    }
    const raw = elemIndex < parts.length ? parts[elemIndex] : '';
    const cleanLen = raw.replace(/[~'\r\n]+$/, '').length;
    return new vscode.Range(lineNum, charPos, lineNum, charPos + Math.max(cleanLen, 1));
}

/**
 * Add VSCode diagnostics for X12 trailer mismatches.
 * Call from validateDocument() for X12 documents only.
 */
export function validateTrailers(
    document: vscode.TextDocument,
    elemDelim: string,
    diagnostics: vscode.Diagnostic[]
): void {
    const errors = analyzeTrailers(document, elemDelim);
    for (const err of errors) {
        const lineText = document.lineAt(err.lineNum).text;
        const range = getTrailerElementRange(lineText, err.elemIndex, elemDelim, err.lineNum);
        const diagnostic = new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'EDI Validator';
        diagnostic.code = 'trailer';
        diagnostics.push(diagnostic);
    }
}
