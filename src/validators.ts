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
}

export interface ValidationResult {
    isValid: boolean;
    errorType?: 'length' | 'dataType' | 'invalidCode';
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
        const codeResult = validateCode(value, schema.codes);
        if (!codeResult.isValid) return codeResult;
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
 * Validate element length against min/max constraints
 */
export function validateLength(value: string, schema: ElementSchema): ValidationResult {
    const len = value.length;

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
 * Validate date/time with EDIFACT format qualifier
 * Used for context-aware validation of date composites (C507, S004, etc.)
 */
export function validateDateWithFormat(value: string, formatCode: string): ValidationResult {
    // Map EDIFACT format codes to validation rules
    // Reference: EDIFACT code list 2379 - Date/time/period format qualifier
    const formatMap: Record<string, { length: number, pattern: 'date' | 'datetime' | 'time', description: string }> = {
        '102': { length: 8, pattern: 'date', description: 'CCYYMMDD' },
        '203': { length: 12, pattern: 'datetime', description: 'CCYYMMDDHHMM' },
        '204': { length: 14, pattern: 'datetime', description: 'CCYYMMDDHHMMSS' },
        '602': { length: 6, pattern: 'date', description: 'YYMMDD' },
        '616': { length: 8, pattern: 'datetime', description: 'YYMMDDHHMM' },
        '718': { length: 10, pattern: 'datetime', description: 'YYMMDDHHMMSS' },
        '201': { length: 10, pattern: 'datetime', description: 'YYMMDDHHMM' },
        '303': { length: 4, pattern: 'time', description: 'HHMM' },
        '304': { length: 6, pattern: 'time', description: 'HHMMSS' },
    };

    const format = formatMap[formatCode];
    if (!format) {
        // Unknown format code - skip specific validation but check if it looks date-like
        if (!/^\d+$/.test(value)) {
            return {
                isValid: false,
                errorType: 'dataType',
                message: `Date/time value contains non-numeric characters`,
                severity: 'error'
            };
        }
        return { isValid: true, message: '', severity: 'warning' };
    }

    // Check length
    if (value.length !== format.length) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Invalid ${format.description} length: ${value.length} (expected ${format.length})`,
            severity: 'error'
        };
    }

    // Check all numeric
    if (!/^\d+$/.test(value)) {
        return {
            isValid: false,
            errorType: 'dataType',
            message: `Date/time contains non-numeric characters`,
            severity: 'error'
        };
    }

    // Validate date portion
    if (format.pattern === 'date' || format.pattern === 'datetime') {
        let year: number, month: number, day: number;
        let dateLength: number;

        if (format.description.startsWith('CCYY')) {
            // 4-digit year
            year = parseInt(value.substring(0, 4), 10);
            month = parseInt(value.substring(4, 6), 10);
            day = parseInt(value.substring(6, 8), 10);
            dateLength = 8;
        } else if (format.description.startsWith('YY')) {
            // 2-digit year
            const yy = parseInt(value.substring(0, 2), 10);
            year = yy < 50 ? 2000 + yy : 1900 + yy;
            month = parseInt(value.substring(2, 4), 10);
            day = parseInt(value.substring(4, 6), 10);
            dateLength = 6;
        } else {
            // Can't determine date format
            return { isValid: true, message: '', severity: 'warning' };
        }

        // Validate month
        if (month < 1 || month > 12) {
            return {
                isValid: false,
                errorType: 'dataType',
                message: `Invalid month: ${month}`,
                severity: 'error'
            };
        }

        // Validate day
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

        // Validate time portion if present
        if (format.pattern === 'datetime' && value.length > dateLength) {
            const timeOffset = dateLength;

            if (value.length >= timeOffset + 2) {
                const hours = parseInt(value.substring(timeOffset, timeOffset + 2), 10);
                if (hours < 0 || hours > 23) {
                    return {
                        isValid: false,
                        errorType: 'dataType',
                        message: `Invalid hour: ${hours}`,
                        severity: 'error'
                    };
                }
            }

            if (value.length >= timeOffset + 4) {
                const minutes = parseInt(value.substring(timeOffset + 2, timeOffset + 4), 10);
                if (minutes < 0 || minutes > 59) {
                    return {
                        isValid: false,
                        errorType: 'dataType',
                        message: `Invalid minutes: ${minutes}`,
                        severity: 'error'
                    };
                }
            }

            if (value.length >= timeOffset + 6) {
                const seconds = parseInt(value.substring(timeOffset + 4, timeOffset + 6), 10);
                if (seconds < 0 || seconds > 59) {
                    return {
                        isValid: false,
                        errorType: 'dataType',
                        message: `Invalid seconds: ${seconds}`,
                        severity: 'error'
                    };
                }
            }
        }
    } else if (format.pattern === 'time') {
        // Validate time-only format
        const hours = parseInt(value.substring(0, 2), 10);
        if (hours < 0 || hours > 23) {
            return {
                isValid: false,
                errorType: 'dataType',
                message: `Invalid hour: ${hours}`,
                severity: 'error'
            };
        }

        if (value.length >= 4) {
            const minutes = parseInt(value.substring(2, 4), 10);
            if (minutes < 0 || minutes > 59) {
                return {
                    isValid: false,
                    errorType: 'dataType',
                    message: `Invalid minutes: ${minutes}`,
                    severity: 'error'
                };
            }
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
    }

    return { isValid: true, message: '', severity: 'warning' };
}