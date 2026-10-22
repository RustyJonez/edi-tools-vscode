/**
 * EDI Element Validation Functions
 *
 * Validates element values against schema constraints including:
 * - Length (min/max)
 * - Data type (AN, N0, N2, ID, DT, TM, R, B)
 * - Code list (for ID type elements)
 */

export interface ElementSchema {
    dataType: string;
    minLength: number;
    maxLength: number;
    codes?: Array<{ code: string; description: string }>;
    elementNumber?: string; // Optional: for composite code validation
}

export interface ValidationResult {
    isValid: boolean;
    errorType?: 'length' | 'dataType' | 'invalidCode' | 'mandatory';
    message: string;
    severity: 'error' | 'warning';
}

/**
 * Master validation function - checks length, data type, and code list
 */
export function validateElement(value: string, schema: ElementSchema): ValidationResult {
    // Empty values are valid (requirement checking is separate)
    if (!value || value.trim() === '') {
        return { isValid: true, message: '', severity: 'warning' };
    }

    // Code list validation - check first if codes exist
    // This applies to both X12 'ID' types and EDIFACT 'AN' types with code lists
    if (schema.codes && schema.codes.length > 0) {
        // Check if this is a composite code element (like X12 element 103 - Packaging Code)
        if (schema.elementNumber && hasValidCodePrefix(value, schema.elementNumber, schema.codes)) {
            // e.g. GS-08 "004010VICS" - version code plus an industry suffix
        } else if (schema.elementNumber && isCompositeCodeElement(schema.elementNumber)) {
            const codeResult = validateCompositeCode(value, schema.elementNumber, schema.codes);
            if (!codeResult.isValid) return codeResult;
        } else {
            const codeResult = validateCode(value, schema.codes);
            if (!codeResult.isValid) return codeResult;
        }
    }

    // Length validation
    const lengthResult = validateLength(value, schema);
    if (!lengthResult.isValid) return lengthResult;

    // Data type validation
    const typeResult = validateDataType(value, schema.dataType);
    if (!typeResult.isValid) return typeResult;

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * Code elements whose value is a listed code followed by a free-form suffix.
 * X12 480 (GS-08): 6-digit version/release plus an industry identifier, e.g. 004010VICS, 005010X222A1.
 */
const PREFIX_CODE_ELEMENTS: Record<string, number> = {
    '480': 6,
};

function hasValidCodePrefix(value: string, elementNumber: string, codes: Array<{ code: string }>): boolean {
    const prefixLength = PREFIX_CODE_ELEMENTS[elementNumber];
    return prefixLength !== undefined
        && value.length > prefixLength
        && codes.some(c => c.code === value.substring(0, prefixLength));
}

/**
 * Validate element length against min/max constraints
 */
export function validateLength(value: string, schema: ElementSchema): ValidationResult {
    const len = isNumericType(schema.dataType) ? numericLength(value) : value.length;

    if (schema.minLength > 0 && len < schema.minLength) {
        return {
            isValid: false,
            errorType: 'length',
            message: `Value too short: ${len} chars (min: ${schema.minLength})`,
            severity: 'error'
        };
    }

    if (schema.maxLength > 0 && len > schema.maxLength) {
        return {
            isValid: false,
            errorType: 'length',
            message: `Value too long: ${len} chars (max: ${schema.maxLength})`,
            severity: 'error'
        };
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/** X12 N0-N9, N and R, and EDIFACT n: a leading minus sign and the decimal mark don't count toward length */
function isNumericType(dataType: string): boolean {
    return /^(N\d?|R)$/i.test(dataType || '');
}

function numericLength(value: string): number {
    return value.replace(/^-/, '').replace(/[.,]/, '').length;
}

/**
 * Validate element value against its data type
 */
export function validateDataType(value: string, dataType: string): ValidationResult {
    switch (dataType) {
        case 'AN': // Alphanumeric - accepts any printable character
            return { isValid: true, message: '', severity: 'warning' };

        case 'N0': // Numeric, no decimal (integer)
            if (!/^-?\d+$/.test(value)) {
                return {
                    isValid: false,
                    errorType: 'dataType',
                    message: `Expected integer, found non-numeric characters`,
                    severity: 'error'
                };
            }
            break;

        case 'N1': case 'N2': case 'N3': case 'N4':
        case 'N5': case 'N6': case 'N7': case 'N8': case 'N9':
            // Numeric with implied decimal (N2 = 2 decimal places implied)
            // In EDI, these are stored without decimal point
            if (!/^-?\d+$/.test(value)) {
                return {
                    isValid: false,
                    errorType: 'dataType',
                    message: `Expected numeric (${dataType}), found non-numeric characters`,
                    severity: 'error'
                };
            }
            break;

        case 'R': // Decimal number (explicit decimal allowed)
            if (!/^-?\d*\.?\d+$/.test(value)) {
                return {
                    isValid: false,
                    errorType: 'dataType',
                    message: `Expected decimal number, found invalid format`,
                    severity: 'error'
                };
            }
            break;

        case 'DT': // Date - CCYYMMDD or YYMMDD
            const dateResult = validateDate(value);
            if (!dateResult.isValid) return dateResult;
            break;

        case 'TM': // Time - HHMM, HHMMSS, or HHMMSSD+
            const timeResult = validateTime(value);
            if (!timeResult.isValid) return timeResult;
            break;

        case 'ID': // Identifier - validated separately against code list
        case 'B':  // Binary - skip validation
            break;

        default:
            // Unknown type - don't validate
            break;
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * Validate date format (CCYYMMDD or YYMMDD)
 */
export function validateDate(value: string): ValidationResult {
    // Accept CCYYMMDD (8 chars) or YYMMDD (6 chars)
    if (value.length !== 6 && value.length !== 8) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid date length: ${value.length} (expected 6 or 8)`,
            severity: 'error'
        };
    }

    if (!/^\d+$/.test(value)) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid date: contains non-numeric characters`,
            severity: 'error'
        };
    }

    let year: number, month: number, day: number;

    if (value.length === 8) {
        year = parseInt(value.substring(0, 4), 10);
        month = parseInt(value.substring(4, 6), 10);
        day = parseInt(value.substring(6, 8), 10);
    } else {
        // YY format - assume 20XX for years < 50, 19XX otherwise
        const yy = parseInt(value.substring(0, 2), 10);
        year = yy < 50 ? 2000 + yy : 1900 + yy;
        month = parseInt(value.substring(2, 4), 10);
        day = parseInt(value.substring(4, 6), 10);
    }

    if (month < 1 || month > 12) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid month: ${month}`,
            severity: 'error'
        };
    }

    if (day < 1 || day > 31) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid day: ${day}`,
            severity: 'error'
        };
    }

    // Check days in month
    const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) {
        daysInMonth[1] = 29; // Leap year
    }

    if (day > daysInMonth[month - 1]) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid day ${day} for month ${month}`,
            severity: 'error'
        };
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * Validate time format (HHMM, HHMMSS, HHMMSSD+)
 */
export function validateTime(value: string): ValidationResult {
    // Accept HHMM (4), HHMMSS (6), HHMMSSD+ (7+)
    if (value.length < 4) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid time length: ${value.length} (minimum 4)`,
            severity: 'error'
        };
    }

    if (!/^\d+$/.test(value)) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid time: contains non-numeric characters`,
            severity: 'error'
        };
    }

    const hours = parseInt(value.substring(0, 2), 10);
    const minutes = parseInt(value.substring(2, 4), 10);

    if (hours < 0 || hours > 23) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid hour: ${hours}`,
            severity: 'error'
        };
    }

    if (minutes < 0 || minutes > 59) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid minutes: ${minutes}`,
            severity: 'error'
        };
    }

    if (value.length >= 6) {
        const seconds = parseInt(value.substring(4, 6), 10);
        if (seconds < 0 || seconds > 59) {
            return {
                isValid: false,
                errorType: 'dataType',
                message: `Invalid seconds: ${seconds}`,
                severity: 'error'
            };
        }
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * Validate element value against code list
 */
export function validateCode(value: string, codes: Array<{ code: string; description: string }>): ValidationResult {
    const isValid = codes.some(c => c.code === value);

    if (!isValid) {
        // Find similar codes for suggestions
        const suggestions = codes
            .filter(c =>
                c.code.toLowerCase().startsWith(value.toLowerCase().charAt(0)) ||
                c.code.toLowerCase().includes(value.toLowerCase())
            )
            .slice(0, 3)
            .map(c => c.code);

        let message = `Invalid code "${value}"`;
        if (suggestions.length > 0) {
            message += ` (similar: ${suggestions.join(', ')})`;
        }

        return {
            isValid: false,
            errorType: 'invalidCode',
            message,
            severity: 'error' // Error since code lists are complete
        };
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * X12 elements that use composite code format (multiple code lists combined)
 * Key: element number, Value: { part1Length, part1Name, part2Name }
 */
const COMPOSITE_CODE_ELEMENTS: Record<string, { part1Length: number; part1Name: string; part2Name: string }> = {
    '103': { part1Length: 3, part1Name: 'Packaging Form', part2Name: 'Packaging Material' },
    // Add other composite code elements here as needed
};

/**
 * Check if an element uses composite code format
 */
export function isCompositeCodeElement(elementNumber: string): boolean {
    return elementNumber in COMPOSITE_CODE_ELEMENTS;
}

/**
 * Validate composite code element (like X12 element 103 - Packaging Code)
 * These elements combine two code lists: Part 1 (e.g., 3-char form) + Part 2 (e.g., 2-char material)
 */
export function validateCompositeCode(
    value: string,
    elementNumber: string,
    codes: Array<{ code: string; description: string }>
): ValidationResult {
    const config = COMPOSITE_CODE_ELEMENTS[elementNumber];
    if (!config) {
        // Not a composite code element, use standard validation
        return validateCode(value, codes);
    }

    const { part1Length, part1Name, part2Name } = config;

    // If value length equals part1Length, it's just Part 1 (valid)
    if (value.length === part1Length) {
        const part1Valid = codes.some(c => c.code === value);
        if (!part1Valid) {
            return {
                isValid: false,
                errorType: 'invalidCode',
                message: `Invalid ${part1Name} code "${value}"`,
                severity: 'error'
            };
        }
        return { isValid: true, message: '', severity: 'warning' };
    }

    // If value length > part1Length, split into Part 1 and Part 2
    if (value.length > part1Length) {
        const part1 = value.substring(0, part1Length);
        const part2 = value.substring(part1Length);

        const part1Valid = codes.some(c => c.code === part1);
        const part2Valid = codes.some(c => c.code === part2);

        if (!part1Valid && !part2Valid) {
            return {
                isValid: false,
                errorType: 'invalidCode',
                message: `Invalid composite code "${value}" - both ${part1Name} "${part1}" and ${part2Name} "${part2}" are invalid`,
                severity: 'error'
            };
        }

        if (!part1Valid) {
            return {
                isValid: false,
                errorType: 'invalidCode',
                message: `Invalid ${part1Name} code "${part1}" in composite code "${value}"`,
                severity: 'error'
            };
        }

        if (!part2Valid) {
            return {
                isValid: false,
                errorType: 'invalidCode',
                message: `Invalid ${part2Name} code "${part2}" in composite code "${value}"`,
                severity: 'error'
            };
        }

        return { isValid: true, message: '', severity: 'warning' };
    }

    // Value is shorter than part1Length - check if it's a valid Part 2 only (some implementations allow this)
    const isValidCode = codes.some(c => c.code === value);
    if (!isValidCode) {
        return {
            isValid: false,
            errorType: 'invalidCode',
            message: `Invalid code "${value}" - expected ${part1Length}-char ${part1Name} or ${part1Length}+2-char composite`,
            severity: 'error'
        };
    }

    return { isValid: true, message: '', severity: 'warning' };
}

/**
 * Get translation for composite code element
 */
export function getCompositeCodeTranslation(
    value: string,
    elementNumber: string,
    codes: Array<{ code: string; description: string }>
): string | null {
    const config = COMPOSITE_CODE_ELEMENTS[elementNumber];
    if (!config) {
        // Not a composite code element
        const code = codes.find(c => c.code === value);
        return code ? code.description : null;
    }

    const { part1Length } = config;

    if (value.length === part1Length) {
        const code = codes.find(c => c.code === value);
        return code ? code.description : null;
    }

    if (value.length > part1Length) {
        const part1 = value.substring(0, part1Length);
        const part2 = value.substring(part1Length);

        const part1Code = codes.find(c => c.code === part1);
        const part2Code = codes.find(c => c.code === part2);

        if (part1Code && part2Code) {
            return `${part1Code.description}, ${part2Code.description}`;
        } else if (part1Code) {
            return part1Code.description;
        } else if (part2Code) {
            return part2Code.description;
        }
    }

    return null;
}

/**
 * EDIFACT date/time/period format qualifiers (code list 2379) mapped to their
 * picture strings. Used when the schema's code list isn't available; when it is,
 * the description from the schema takes precedence.
 */
const DATE_FORMAT_PATTERNS: Record<string, string> = {
    '2': 'DDMMYY', '3': 'MMDDYY', '4': 'DDMMCCYY', '5': 'DDMMCCYYHHMM', '10': 'CCYYMMDDTHHMM',
    '101': 'YYMMDD', '102': 'CCYYMMDD', '103': 'YYWWD', '105': 'YYDDD', '106': 'MMDD',
    '107': 'DDD', '108': 'WW', '109': 'MM', '110': 'DD',
    '201': 'YYMMDDHHMM', '202': 'YYMMDDHHMMSS', '203': 'CCYYMMDDHHMM', '204': 'CCYYMMDDHHMMSS',
    '301': 'YYMMDDHHMMZZZ', '302': 'YYMMDDHHMMSSZZZ', '303': 'CCYYMMDDHHMMZZZ', '304': 'CCYYMMDDHHMMSSZZZ',
    '305': 'MMDDHHMM', '306': 'DDHHMM', '307': 'CCYYMMDDHHMMSSFFF', '308': 'CCYYMMDDHHMMZZZ-CCYYMMDDHHMMZZZ',
    '401': 'HHMM', '402': 'HHMMSS', '404': 'HHMMSSZZZ',
    '501': 'HHMMHHMM', '502': 'HHMMSS-HHMMSS', '503': 'HHMMSSZZZ-HHMMSSZZZ',
    '600': 'CC', '601': 'YY', '602': 'CCYY', '609': 'YYMM', '610': 'CCYYMM', '615': 'YYWW', '616': 'CCYYWW',
    '701': 'YY-YY', '702': 'CCYY-CCYY', '709': 'YYMM-YYMM', '710': 'CCYYMM-CCYYMM',
    '711': 'CCYYMMDD-CCYYMMDD', '713': 'YYMMDDHHMM-YYMMDDHHMM', '715': 'YYWW-YYWW', '716': 'CCYYWW-CCYYWW',
    '717': 'YYMMDD-YYMMDD', '718': 'CCYYMMDD-CCYYMMDD', '719': 'CCYYMMDDHHMM-CCYYMMDDHHMM', '720': 'DHHMM-DHHMM',
};

type DateToken = 'CCYY' | 'YY' | 'CC' | 'MONTH' | 'DD' | 'DDD' | 'D' | 'HH' | 'MIN' | 'SS' | 'WW' | 'ZZZ' | 'FFF' | '-' | 'T';

const TOKEN_WIDTH: Record<DateToken, number> = {
    CCYY: 4, YY: 2, CC: 2, MONTH: 2, DD: 2, DDD: 3, D: 1, HH: 2, MIN: 2, SS: 2, WW: 2, ZZZ: 3, FFF: 3, '-': 1, T: 1
};

/**
 * Break a picture string such as "CCYYMMDDHHMM-CCYYMMDDHHMM" into tokens.
 * Returns undefined for pictures containing parts we can't check (e.g. Z, S, Q, P),
 * in which case the value is not validated rather than risk a false error.
 */
function tokenizeDatePattern(pattern: string): DateToken[] | undefined {
    const tokens: DateToken[] = [];
    let i = 0;
    while (i < pattern.length) {
        const rest = pattern.substring(i);
        const prev = tokens[tokens.length - 1];
        let tok: DateToken | undefined;
        if (rest.startsWith('CCYY')) tok = 'CCYY';
        else if (rest.startsWith('CC')) tok = 'CC';
        else if (rest.startsWith('YY')) tok = 'YY';
        else if (rest.startsWith('MM')) tok = prev === 'HH' ? 'MIN' : 'MONTH';
        else if (rest.startsWith('DDD')) tok = 'DDD';
        else if (rest.startsWith('DD')) tok = 'DD';
        else if (rest.startsWith('HH')) tok = 'HH';
        else if (rest.startsWith('SS')) tok = 'SS';
        else if (rest.startsWith('WW')) tok = 'WW';
        else if (rest.startsWith('ZZZ')) tok = 'ZZZ';
        else if (rest.startsWith('FFF')) tok = 'FFF';
        else if (rest.startsWith('D')) tok = 'D';
        else if (rest.startsWith('-')) tok = '-';
        else if (rest.startsWith('T')) tok = 'T';
        if (!tok) return undefined;
        tokens.push(tok);
        i += TOKEN_WIDTH[tok];
    }
    return tokens;
}

function dateError(message: string): ValidationResult {
    return { isValid: false, errorType: 'dataType', message, severity: 'error' };
}

/** Check a value against a 2379-style picture string. Undefined = picture not checkable. */
export function validateDatePattern(value: string, pattern: string): ValidationResult | undefined {
    const tokens = tokenizeDatePattern(pattern);
    if (!tokens) return undefined;

    const expectedLength = tokens.reduce((n, t) => n + TOKEN_WIDTH[t], 0);
    if (value.length !== expectedLength) {
        return dateError(`Invalid ${pattern} length: ${value.length} (expected ${expectedLength})`);
    }

    // Year/month/day are tracked per range part so each date is checked on its own
    let year: number | undefined, month: number | undefined, day: number | undefined;
    const checkDayInMonth = (): ValidationResult | undefined => {
        if (month === undefined || day === undefined) return undefined;
        const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        const y = year ?? 2000; // no year in picture: allow Feb 29
        if ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) daysInMonth[1] = 29;
        if (day > daysInMonth[month - 1]) return dateError(`Invalid day ${day} for month ${month}`);
        return undefined;
    };

    let pos = 0;
    for (const tok of tokens) {
        const part = value.substring(pos, pos + TOKEN_WIDTH[tok]);
        pos += TOKEN_WIDTH[tok];

        if (tok === '-' || tok === 'T') {
            if (part !== tok) return dateError(`Expected "${tok}" at position ${pos} (format ${pattern})`);
            if (tok === '-') {
                const r = checkDayInMonth();
                if (r) return r;
                year = month = day = undefined;
            }
            continue;
        }
        if (tok === 'ZZZ') continue; // time zone code - free text

        if (!/^\d+$/.test(part)) {
            return dateError(`Date/time contains non-numeric characters (format ${pattern})`);
        }
        const n = parseInt(part, 10);
        switch (tok) {
            case 'CCYY': year = n; break;
            case 'YY': year = n < 50 ? 2000 + n : 1900 + n; break;
            case 'MONTH':
                if (n < 1 || n > 12) return dateError(`Invalid month: ${n}`);
                month = n; break;
            case 'DD':
                if (n < 1 || n > 31) return dateError(`Invalid day: ${n}`);
                day = n; break;
            case 'DDD':
                if (n < 1 || n > 366) return dateError(`Invalid day of year: ${n}`);
                break;
            case 'D':
                if (n < 1 || n > 7) return dateError(`Invalid day of week: ${n}`);
                break;
            case 'WW':
                if (n < 1 || n > 53) return dateError(`Invalid week: ${n}`);
                break;
            case 'HH':
                if (n > 23) return dateError(`Invalid hour: ${n}`);
                break;
            case 'MIN':
                if (n > 59) return dateError(`Invalid minutes: ${n}`);
                break;
            case 'SS':
                if (n > 59) return dateError(`Invalid seconds: ${n}`);
                break;
        }
    }

    return checkDayInMonth() ?? { isValid: true, message: '', severity: 'warning' };
}

/**
 * Validate date/time with EDIFACT format qualifier (code list 2379).
 * Used for context-aware validation of the C507 composite (DTM).
 * `codes` is the 2379 code list from the loaded schema, when available.
 */
export function validateDateWithFormat(
    value: string,
    formatCode: string,
    codes?: Array<{ code: string; description: string }>
): ValidationResult {
    const fromSchema = codes?.find(c => c.code === formatCode)?.description;
    const pattern = fromSchema && /^[A-Z-]+$/.test(fromSchema) ? fromSchema : DATE_FORMAT_PATTERNS[formatCode];

    // Unknown qualifier or a picture we can't check (e.g. "Month", "CCYYQ") - don't guess
    const result = pattern ? validateDatePattern(value, pattern) : undefined;
    return result ?? { isValid: true, message: '', severity: 'warning' };
}
