import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { validateElement, validateDateWithFormat, ElementSchema } from './validators';

interface SegmentInfo {
    code: string;
    name: string;
    description: string;
    elements?: ElementInfo[];
}

interface ElementInfo {
    position: string;
    name: string;
    requirement: string;
    type: string;
    definition?: string;
    dataType?: string;
    minLength?: number;
    maxLength?: number;
    codeCount?: number;
}

interface ElementDetailInfo {
    elementNumber: string;
    name: string;
    definition: string;
    dataType: string;
    minLength: number;
    maxLength: number;
    codes?: CodeValue[];
}

interface CodeValue {
    code: string;
    description: string;
}

interface ComponentInfo {
    position: string;
    elementId: string;
    name: string;
    requirement: string;
}

interface CompositeElementInfo extends ElementDetailInfo {
    components?: ComponentInfo[];
}

// Schema caches with version-qualified keys (e.g., "x12:004010:ISA", "edifact:d96a:UNH")
const segmentCache = new Map<string, SegmentInfo>();
const elementCache = new Map<string, ElementDetailInfo>();
const compositeCache = new Map<string, CompositeElementInfo>();

// Track which versions have been loaded
const loadedVersions = new Set<string>();

export class EdiHoverProvider implements vscode.HoverProvider {
    private extensionPath: string = '';
    private documentVersionCache = new Map<string, string>(); // Document URI -> version

    constructor(extensionPath?: string) {
        if (extensionPath) {
            this.extensionPath = extensionPath;
        }
    }

    /**
     * Initialize with extension path (no longer preloads schemas)
     */
    public async loadSchemas(extensionPath: string): Promise<void> {
        this.extensionPath = extensionPath;
        console.log('[EDI Hover] Ready for dynamic schema loading');
    }

    /**
     * Detect EDIFACT version from UNH segment
     */
    private detectEdifactVersion(document: vscode.TextDocument): string | null {
        // Read first 20 lines to find UNH segment
        const lineCount = Math.min(20, document.lineCount);
        for (let i = 0; i < lineCount; i++) {
            const line = document.lineAt(i).text;
            // UNH format: UNH+ref+MSGTYPE:D:VERSION:UN
            const unhMatch = line.match(/^UNH\+[^+]+\+[^:]+:D:(\d{2}[AB]):UN/i);
            if (unhMatch) {
                return unhMatch[1].toUpperCase();
            }
        }
        return null;
    }

    /**
     * Detect X12 version from ISA segment
     */
    private detectX12Version(document: vscode.TextDocument): string | null {
        // ISA version is at positions 85-89 (5 characters), format: 00401
        if (document.lineCount > 0) {
            const firstLine = document.lineAt(0).text;
            if (firstLine.startsWith('ISA') && firstLine.length >= 89) {
                const isaVersion = firstLine.substring(84, 89).trim();
                // Convert 5-char format (00401) to 6-char format (004010)
                return this.normalizeX12Version(isaVersion);
            }
        }
        return null;
    }

    /**
     * Normalize X12 version from ISA format (00401) to standard format (004010)
     */
    private normalizeX12Version(isaVersion: string): string {
        // ISA format: 00401 -> Standard format: 004010
        // Pattern: XXYYZ -> XXYY0Z or XXYY00 depending on Z
        let version = isaVersion;
        if (isaVersion.length === 5) {
            // Add a trailing 0: 00401 -> 004010
            version = isaVersion + '0';
        }

        // Map common version variations to available schemas
        // e.g., 004000 -> 004010, 002000 -> 002040 (closest match)
        const versionMappings: Record<string, string> = {
            '002000': '002040',
            '003000': '003010',
            '004000': '004010',
            '005000': '005010',
            '006000': '006010',
            '007000': '007010',
            '008000': '008010',
        };

        if (versionMappings[version]) {
            console.log(`[EDI Hover] Mapping version ${version} to ${versionMappings[version]}`);
            version = versionMappings[version];
        }

        return version;
    }

    /**
     * Get or detect version for a document
     */
    private async getDocumentVersion(document: vscode.TextDocument, isEdifact: boolean): Promise<string> {
        const cacheKey = document.uri.toString();

        // Check cache first
        if (this.documentVersionCache.has(cacheKey)) {
            return this.documentVersionCache.get(cacheKey)!;
        }

        // Detect version
        let detectedVersion: string | null = null;
        if (isEdifact) {
            detectedVersion = this.detectEdifactVersion(document);
            console.log(`[EDI Hover] Detected EDIFACT version: ${detectedVersion || 'none'}`);
        } else {
            detectedVersion = this.detectX12Version(document);
            console.log(`[EDI Hover] Detected X12 version: ${detectedVersion || 'none'}`);
        }

        // Fallback to common versions if not detected
        const fallbackVersions = isEdifact
            ? ['d96a', 'd01b', 'd03a', 'd98b', 'd21a']
            : ['004010', '005010', '008010', '003070', '003060', '003010', '007020'];

        let version = detectedVersion?.toLowerCase() || fallbackVersions[0];

        // If detected version doesn't exist, try fallbacks
        if (detectedVersion) {
            const versionKey = isEdifact ? `edifact:${version}` : `x12:${version}`;
            if (!loadedVersions.has(versionKey)) {
                const schemaDir = path.join(
                    this.extensionPath,
                    'schemas',
                    isEdifact ? 'edifact' : 'x12',
                    version
                );
                if (!fs.existsSync(schemaDir)) {
                    console.log(`[EDI Hover] Version ${version} not found, trying fallbacks...`);
                    version = fallbackVersions[0];
                }
            }
        }

        // Cache the version
        this.documentVersionCache.set(cacheKey, version);

        // Load schemas if not already loaded
        if (isEdifact) {
            await this.ensureEdifactSchemasLoaded(version);
        } else {
            await this.ensureX12SchemasLoaded(version);
        }

        return version;
    }

    /**
     * Ensure EDIFACT schemas for a version are loaded
     */
    private async ensureEdifactSchemasLoaded(version: string): Promise<void> {
        const versionKey = `edifact:${version}`;
        if (!loadedVersions.has(versionKey)) {
            console.log(`[EDI Hover] Loading EDIFACT ${version.toUpperCase()} schemas...`);
            await this.loadEdifactSchemas(version);
            loadedVersions.add(versionKey);
        }
    }

    /**
     * Ensure X12 schemas for a version are loaded
     */
    private async ensureX12SchemasLoaded(version: string): Promise<void> {
        const versionKey = `x12:${version}`;
        if (!loadedVersions.has(versionKey)) {
            console.log(`[EDI Hover] Loading X12 ${version} schemas...`);
            await this.loadX12Schemas(version);
            loadedVersions.add(versionKey);
        }
    }

    private async loadX12Schemas(version: string): Promise<void> {
        const schemaDir = path.join(this.extensionPath, 'schemas', 'x12', version);

        // Load segments
        const segmentsPath = path.join(schemaDir, 'segments.json');
        if (fs.existsSync(segmentsPath)) {
            const segmentsData = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
            for (const [code, data] of Object.entries(segmentsData)) {
                segmentCache.set(`x12:${version}:${code}`, data as SegmentInfo);
            }
            console.log(`[EDI Hover] Loaded ${Object.keys(segmentsData).length} X12 ${version} segments`);
        }

        // Load elements
        const elementsPath = path.join(schemaDir, 'elements.json');
        if (fs.existsSync(elementsPath)) {
            const elementsData = JSON.parse(fs.readFileSync(elementsPath, 'utf-8'));
            for (const [elementNum, data] of Object.entries(elementsData)) {
                elementCache.set(`x12:${version}:${elementNum}`, data as ElementDetailInfo);
            }
            console.log(`[EDI Hover] Loaded ${Object.keys(elementsData).length} X12 ${version} elements`);
        }
    }

    private async loadEdifactSchemas(version: string): Promise<void> {
        const schemaDir = path.join(this.extensionPath, 'schemas', 'edifact', version);

        // Load segments
        const segmentsPath = path.join(schemaDir, 'segments.json');
        if (fs.existsSync(segmentsPath)) {
            const segmentsData = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
            for (const [code, data] of Object.entries(segmentsData)) {
                segmentCache.set(`edifact:${version}:${code}`, data as SegmentInfo);
            }
            console.log(`[EDI Hover] Loaded ${Object.keys(segmentsData).length} EDIFACT ${version.toUpperCase()} segments`);
        }

        // Load elements
        const elementsPath = path.join(schemaDir, 'elements.json');
        if (fs.existsSync(elementsPath)) {
            const elementsData = JSON.parse(fs.readFileSync(elementsPath, 'utf-8'));
            for (const [elementNum, data] of Object.entries(elementsData)) {
                elementCache.set(`edifact:${version}:${elementNum}`, data as ElementDetailInfo);
            }
            console.log(`[EDI Hover] Loaded ${Object.keys(elementsData).length} EDIFACT ${version.toUpperCase()} elements`);
        }

        // Load composite elements
        const compositesPath = path.join(schemaDir, 'composites.json');
        if (fs.existsSync(compositesPath)) {
            const compositesData = JSON.parse(fs.readFileSync(compositesPath, 'utf-8'));
            for (const [compositeNum, data] of Object.entries(compositesData)) {
                compositeCache.set(`edifact:${version}:${compositeNum}`, data as CompositeElementInfo);
            }
            console.log(`[EDI Hover] Loaded ${Object.keys(compositesData).length} EDIFACT ${version.toUpperCase()} composites`);
        }
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const line = document.lineAt(position.line);
        const lineText = line.text;

        console.log(`[EDI Hover] Line: "${lineText}", Cursor at position: ${position.character}`);

        // Detect language based on file extension or content
        const isEdifact = document.languageId === 'edifact' ||
                         !!lineText.match(/^(UNA|UNB|UNH|UNT|UNZ)/);
        const languagePrefix = isEdifact ? 'edifact' : 'x12';

        console.log(`[EDI Hover] Detected language: ${languagePrefix}`);

        // Detect and load version-specific schemas
        const version = await this.getDocumentVersion(document, isEdifact);
        console.log(`[EDI Hover] Using version: ${version}`);

        // Extract segment code at the beginning of the line
        const segmentMatch = lineText.match(/^([A-Z0-9]{2,3})(?=\*|\+|:)/);
        if (!segmentMatch) {
            console.log('[EDI Hover] No segment match found');
            return undefined;
        }

        const segmentCode = segmentMatch[1];
        console.log(`[EDI Hover] Segment code: ${segmentCode}`);

        // Detect element delimiter (usually * for X12, + for EDIFACT)
        const elementDelimiter = lineText.includes('*') ? '*' : (lineText.includes('+') ? '+' : ':');
        console.log(`[EDI Hover] Element delimiter: ${elementDelimiter}`);

        // Check if cursor is on the segment code or on an element
        if (position.character <= segmentCode.length) {
            // Cursor is on segment code - show segment info
            console.log('[EDI Hover] Cursor on segment code');
            return this.showSegmentHover(segmentCode, languagePrefix, version);
        } else {
            // Cursor is on an element - determine which element
            const elementPosition = this.getElementPosition(lineText, position.character, segmentCode, elementDelimiter);
            console.log(`[EDI Hover] Element position: ${elementPosition}`);
            if (elementPosition) {
                return this.showElementHover(segmentCode, elementPosition, lineText, elementDelimiter, languagePrefix, position.character, version);
            }
        }

        return undefined;
    }

    private async showSegmentHover(segmentCode: string, languagePrefix: string, version: string): Promise<vscode.Hover | undefined> {
        try {
            const segmentInfo = this.getSegmentInfo(segmentCode, languagePrefix, version);
            if (!segmentInfo) {
                vscode.window.setStatusBarMessage(`EDI: No info found for ${segmentCode}`, 2000);
                return undefined;
            }

            vscode.window.setStatusBarMessage(`EDI: Showing ${segmentCode} - ${segmentInfo.name}`, 2000);

            const markdown = this.createSegmentMarkdown(segmentInfo, languagePrefix, version);
            return new vscode.Hover(markdown);
        } catch (error) {
            console.error('Error fetching segment info:', error);
            vscode.window.setStatusBarMessage(`EDI: Error fetching ${segmentCode}`, 2000);
            return undefined;
        }
    }

    private async showElementHover(
        segmentCode: string,
        elementPosition: number,
        lineText: string,
        elementDelimiter: string,
        languagePrefix: string,
        cursorPosition: number | undefined,
        version: string
    ): Promise<vscode.Hover | undefined> {
        try {
            // First get segment info to find element number
            const segmentInfo = this.getSegmentInfo(segmentCode, languagePrefix, version);
            if (!segmentInfo || !segmentInfo.elements || elementPosition > segmentInfo.elements.length) {
                return undefined;
            }

            const elementInfo = segmentInfo.elements[elementPosition - 1];
            if (!elementInfo) {
                return undefined;
            }

            // Get the actual value of this element from the line
            const elementValue = this.getElementValue(lineText, elementPosition, elementDelimiter);

            // For EDIFACT, check if this is a composite element (starts with 'C' or 'S')
            // 'C' = Composite data elements, 'S' = Service composite elements
            // Also check if element value contains ':' separator
            if (languagePrefix === 'edifact' && elementValue.includes(':') && cursorPosition !== undefined) {
                const compositeInfo = this.getCompositeDetail(elementInfo.type, languagePrefix, version);

                // Get component position within the composite
                const componentPos = this.getComponentPosition(elementValue, cursorPosition, lineText, elementPosition, elementDelimiter, segmentCode);

                if (componentPos !== null) {
                    const componentValue = this.getComponentValue(elementValue, componentPos);

                    // If we have composite metadata, use it
                    if (compositeInfo && compositeInfo.components && compositeInfo.components.length > 0 && componentPos <= compositeInfo.components.length) {
                        const componentInfo = compositeInfo.components[componentPos - 1];
                        const componentDetail = this.getElementDetail(componentInfo.elementId, languagePrefix, version);

                        vscode.window.setStatusBarMessage(`EDI: Showing ${segmentCode}-${elementPosition.toString().padStart(2, '0')}-${componentPos.toString().padStart(2, '0')}`, 2000);

                        const markdown = this.createComponentMarkdown(segmentCode, elementPosition, componentPos, componentInfo, componentValue, componentDetail, languagePrefix, version, elementInfo.type, elementValue);
                        return new vscode.Hover(markdown);
                    } else {
                        // No composite metadata available, show generic component info
                        const md = new vscode.MarkdownString();
                        md.supportHtml = true;
                        md.isTrusted = true;

                        const elementId = `${segmentCode}-${elementPosition.toString().padStart(2, '0')}-${componentPos.toString().padStart(2, '0')}`;
                        md.appendMarkdown(`### ${elementId} - Component ${componentPos}\n\n`);
                        md.appendMarkdown(`**Element**: ${elementInfo.type}\n\n`);
                        md.appendMarkdown(`**Current value:** \`${componentValue}\`\n\n`);
                        md.appendMarkdown(`*Composite element definition not available*\n`);

                        vscode.window.setStatusBarMessage(`EDI: Showing ${elementId}`, 2000);
                        return new vscode.Hover(md);
                    }
                }
            }

            // Get detailed element information including codes
            const elementDetail = this.getElementDetail(elementInfo.type, languagePrefix, version);

            vscode.window.setStatusBarMessage(`EDI: Showing ${segmentCode}-${elementPosition.toString().padStart(2, '0')}`, 2000);

            const markdown = this.createElementMarkdown(segmentCode, elementPosition, elementInfo, elementValue, elementDetail, languagePrefix, version);
            return new vscode.Hover(markdown);
        } catch (error) {
            console.error('Error fetching element info:', error);
            return undefined;
        }
    }

    private getElementPosition(lineText: string, cursorPosition: number, segmentCode: string, delimiter: string): number | null {
        // Split by delimiter to get elements
        const parts = lineText.split(delimiter);

        // First part is the segment code
        if (parts.length < 2) {
            return null;
        }

        let currentPos = segmentCode.length; // Start after segment code

        for (let i = 1; i < parts.length; i++) {
            currentPos++; // Account for delimiter
            const elementEnd = currentPos + parts[i].length;

            if (cursorPosition >= currentPos && cursorPosition <= elementEnd) {
                return i; // Return 1-based element position
            }

            currentPos = elementEnd;
        }

        return null;
    }

    private getElementValue(lineText: string, elementPosition: number, delimiter: string): string {
        const parts = lineText.split(delimiter);
        if (elementPosition < parts.length) {
            // Remove segment terminator (~, ', \n, \r) and trailing whitespace from the value
            let value = parts[elementPosition].replace(/[~'\n\r]+$/g, '');
            // Don't trim - whitespace can be significant in EDI
            return value;
        }
        return '';
    }

    private getSegmentInfo(segmentCode: string, languagePrefix: string, version: string): SegmentInfo | null {
        const cacheKey = `${languagePrefix}:${version}:${segmentCode}`;
        return segmentCache.get(cacheKey) || null;
    }

    private getElementDetail(elementNumber: string, languagePrefix: string, version: string): ElementDetailInfo | null {
        const cacheKey = `${languagePrefix}:${version}:${elementNumber}`;
        return elementCache.get(cacheKey) || null;
    }

    private getCompositeDetail(compositeNumber: string, languagePrefix: string, version: string): CompositeElementInfo | null {
        const cacheKey = `${languagePrefix}:${version}:${compositeNumber}`;
        return compositeCache.get(cacheKey) || null;
    }

    /**
     * Get component position within a composite element
     */
    private getComponentPosition(
        elementValue: string,
        cursorPosition: number,
        lineText: string,
        elementPosition: number,
        elementDelimiter: string,
        segmentCode: string
    ): number | null {
        // Calculate where this element starts in the line
        const parts = lineText.split(elementDelimiter);
        let elementStartPos = segmentCode.length;
        for (let i = 1; i < elementPosition; i++) {
            elementStartPos += 1 + parts[i].length; // +1 for delimiter
        }
        elementStartPos += 1; // Account for the delimiter before this element

        // Calculate cursor position relative to element start
        const relativePos = cursorPosition - elementStartPos;

        // Split element value by component separator (:)
        const components = elementValue.split(':');
        let currentPos = 0;

        for (let i = 0; i < components.length; i++) {
            const componentEnd = currentPos + components[i].length;

            if (relativePos >= currentPos && relativePos <= componentEnd) {
                return i + 1; // Return 1-based component position
            }

            currentPos = componentEnd + 1; // +1 for the : separator
        }

        return null;
    }

    /**
     * Get value of a specific component within a composite element
     */
    private getComponentValue(elementValue: string, componentPosition: number): string {
        const components = elementValue.split(':');
        if (componentPosition <= components.length) {
            // Don't trim - preserve the actual value including whitespace
            return components[componentPosition - 1];
        }
        return '';
    }

    private createElementMarkdown(
        segmentCode: string,
        elementPosition: number,
        elementInfo: ElementInfo,
        elementValue: string,
        elementDetail: ElementDetailInfo | null,
        languagePrefix: string,
        version: string
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = true;

        const elementId = `${segmentCode}-${elementPosition.toString().padStart(2, '0')}`;

        console.log(`[EDI] Creating markdown for ${elementId}, value: ${elementValue}`);
        console.log(`[EDI] elementDetail: ${elementDetail ? 'exists' : 'null'}`);
        if (elementDetail) {
            console.log(`[EDI] elementDetail.codes: ${elementDetail.codes ? elementDetail.codes.length + ' codes' : 'undefined'}`);
        }

        // Check if this is a composite element (for EDIFACT)
        const isComposite = languagePrefix === 'edifact' && (elementInfo.type.startsWith('C') || elementInfo.type.startsWith('S'));
        const compositeInfo = isComposite ? this.getCompositeDetail(elementInfo.type, languagePrefix, version) : null;

        console.log(`[EDI] isComposite: ${isComposite}, compositeInfo: ${compositeInfo ? 'exists' : 'null'}`);

        // Header with element ID and name
        md.appendMarkdown(`### ${elementId} - ${elementInfo.name}\n\n`);

        // For composite elements, check if it's a single component (no colons) or multi-component
        if (compositeInfo && compositeInfo.components && compositeInfo.components.length > 0) {
            const isSingleComponent = !elementValue.includes(':');

            if (isSingleComponent && compositeInfo.components.length > 0) {
                // Single component composite - show the first component's details with codes
                const firstComponent = compositeInfo.components[0];
                const componentDetail = this.getElementDetail(firstComponent.elementId, languagePrefix, version);

                if (componentDetail) {
                    const typeInfo = `\`Type: ${componentDetail.dataType}\` \`Length: ${componentDetail.minLength}-${componentDetail.maxLength}\` \`${elementInfo.requirement}\``;
                    md.appendMarkdown(`${typeInfo}\n\n`);

                    md.appendMarkdown(`*${firstComponent.name} (${compositeInfo.name})*\n\n`);

                    // Current value with translation
                    if (elementValue) {
                        md.appendMarkdown(`**Current value:** \`${elementValue}\`\n\n`);

                        // Validate the component value
                        const schema: ElementSchema = {
                            dataType: componentDetail.dataType,
                            minLength: componentDetail.minLength,
                            maxLength: componentDetail.maxLength,
                            codes: componentDetail.codes
                        };
                        const validation = validateElement(elementValue, schema);
                        if (!validation.isValid) {
                            const icon = validation.severity === 'error' ? '❌' : '⚠️';
                            md.appendMarkdown(`${icon} **${validation.severity.charAt(0).toUpperCase() + validation.severity.slice(1)}:** ${validation.message}\n\n`);
                        }

                        // Show code translation if available
                        if (componentDetail.codes && componentDetail.codes.length > 0) {
                            const codeTranslation = componentDetail.codes.find(c => c.code === elementValue);
                            if (codeTranslation) {
                                md.appendMarkdown(`**Translation:** ${codeTranslation.description}\n\n`);
                            }

                            // Show available codes (limit to first 10)
                            md.appendMarkdown(`**Available codes:**\n\n`);
                            const codesToShow = componentDetail.codes.slice(0, 10);
                            for (const code of codesToShow) {
                                const highlight = code.code === elementValue ? '**' : '';
                                md.appendMarkdown(`- ${highlight}\`${code.code}\`: ${code.description}${highlight}\n`);
                            }

                            if (componentDetail.codes.length > 10) {
                                md.appendMarkdown(`\n_...and ${componentDetail.codes.length - 10} more_\n`);
                            }
                        }
                    }

                    // Show that this is part of a composite with other optional components
                    if (compositeInfo.components.length > 1) {
                        md.appendMarkdown(`\n**Other composite components:**\n\n`);
                        for (let i = 1; i < compositeInfo.components.length; i++) {
                            const comp = compositeInfo.components[i];
                            md.appendMarkdown(`- **${comp.position}** \`${comp.elementId}\`: ${comp.name} (Optional)\n`);
                        }
                        md.appendMarkdown(`\n*Tip: Use \`:\` separator to include additional components*\n`);
                    }
                } else {
                    // Fallback to generic composite display
                    const typeInfo = `\`Type: ${compositeInfo.dataType}\` \`Length: ${compositeInfo.minLength}-${compositeInfo.maxLength}\` \`${elementInfo.requirement}\``;
                    md.appendMarkdown(`${typeInfo}\n\n`);
                    md.appendMarkdown(`**Current value:** \`${elementValue}\`\n\n`);
                }
            } else {
                // Multi-component composite - show composite structure
                const typeInfo = `\`Type: ${compositeInfo.dataType}\` \`Length: ${compositeInfo.minLength}-${compositeInfo.maxLength}\` \`${elementInfo.requirement}\``;
                md.appendMarkdown(`${typeInfo}\n\n`);

                // Definition
                if (compositeInfo.definition) {
                    md.appendMarkdown(`*${compositeInfo.definition}*\n\n`);
                }

                // Current value
                if (elementValue) {
                    md.appendMarkdown(`**Current value:** \`${elementValue}\`\n\n`);

                    // Validate the element value
                    const schema: ElementSchema = {
                        dataType: compositeInfo.dataType,
                        minLength: compositeInfo.minLength,
                        maxLength: compositeInfo.maxLength,
                        codes: compositeInfo.codes
                    };
                    const validation = validateElement(elementValue, schema);
                    if (!validation.isValid) {
                        const icon = validation.severity === 'error' ? '❌' : '⚠️';
                        md.appendMarkdown(`${icon} **${validation.severity.charAt(0).toUpperCase() + validation.severity.slice(1)}:** ${validation.message}\n\n`);
                    }
                }

                // Show composite components
                md.appendMarkdown(`**Composite structure:**\n\n`);
                for (const component of compositeInfo.components) {
                    const req = component.requirement === 'M' ? 'Required' : 'Conditional';
                    md.appendMarkdown(`- **${component.position}** \`${component.elementId}\`: ${component.name} (${req})\n`);
                }
                md.appendMarkdown(`\n*Tip: Hover over individual components separated by \`:\` to see detailed information*\n`);
            }
        } else if (elementDetail) {
            // Regular element with potential codes
            const typeInfo = `\`Type: ${elementDetail.dataType}\` \`Length: ${elementDetail.minLength}-${elementDetail.maxLength}\` \`${elementInfo.requirement}\``;
            md.appendMarkdown(`${typeInfo}\n\n`);

            // Definition
            if (elementDetail.definition) {
                md.appendMarkdown(`*${elementDetail.definition}*\n\n`);
            }

            // Current value with translation
            if (elementValue) {
                md.appendMarkdown(`**Current value:** \`${elementValue}\`\n\n`);

                // Validate the element value
                const schema: ElementSchema = {
                    dataType: elementDetail.dataType,
                    minLength: elementDetail.minLength,
                    maxLength: elementDetail.maxLength,
                    codes: elementDetail.codes
                };
                const validation = validateElement(elementValue, schema);
                if (!validation.isValid) {
                    const icon = validation.severity === 'error' ? '❌' : '⚠️';
                    md.appendMarkdown(`${icon} **${validation.severity.charAt(0).toUpperCase() + validation.severity.slice(1)}:** ${validation.message}\n\n`);
                }

                // If this element has codes, show the translation
                if (elementDetail.codes && elementDetail.codes.length > 0) {
                    console.log(`[EDI] Looking for translation of '${elementValue}' in ${elementDetail.codes.length} codes`);
                    const codeTranslation = elementDetail.codes.find(c => c.code === elementValue);
                    if (codeTranslation) {
                        console.log(`[EDI] Found translation: ${codeTranslation.description}`);
                        md.appendMarkdown(`**Translation:** ${codeTranslation.description}\n\n`);
                    } else {
                        console.log(`[EDI] No translation found for '${elementValue}'`);
                    }

                    // Show available codes (limit to first 10)
                    md.appendMarkdown(`**Available codes:**\n\n`);
                    const codesToShow = elementDetail.codes.slice(0, 10);
                    for (const code of codesToShow) {
                        const highlight = code.code === elementValue ? '**' : '';
                        md.appendMarkdown(`- ${highlight}\`${code.code}\`: ${code.description}${highlight}\n`);
                    }

                    if (elementDetail.codes.length > 10) {
                        md.appendMarkdown(`\n_...and ${elementDetail.codes.length - 10} more_\n`);
                    }
                } else {
                    console.log(`[EDI] No codes available for this element`);
                }
            }
        } else {
            console.log(`[EDI] No element detail available, using fallback`);
            // Fallback if we couldn't get detailed info
            const typeInfo = `\`Element: ${elementInfo.type}\` \`${elementInfo.requirement}\``;
            md.appendMarkdown(`${typeInfo}\n\n`);

            if (elementValue) {
                md.appendMarkdown(`**Current value:** \`${elementValue}\`\n\n`);
            }
        }

        // Link to full reference
        md.appendMarkdown(`\n\n---\n`);
        if (languagePrefix === 'edifact') {
            md.appendMarkdown(`[View element reference →](https://www.stedi.com/edi/edifact/elements/${elementInfo.type})`);
        } else {
            md.appendMarkdown(`[View element reference →](https://www.stedi.com/edi/x12/element/${elementInfo.type})`);
        }

        return md;
    }

    private createComponentMarkdown(
        segmentCode: string,
        elementPosition: number,
        componentPosition: number,
        componentInfo: ComponentInfo,
        componentValue: string,
        componentDetail: ElementDetailInfo | null,
        _languagePrefix: string,
        _version: string,
        compositeType?: string,
        fullElementValue?: string
    ): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = true;

        const componentId = `${segmentCode}-${elementPosition.toString().padStart(2, '0')}-${componentPosition.toString().padStart(2, '0')}`;

        console.log(`[EDI Hover] Creating component markdown for ${componentId}, value: ${componentValue}`);

        // Header with component ID and name
        md.appendMarkdown(`### ${componentId} - ${componentInfo.name}\n\n`);

        // Component metadata
        if (componentDetail) {
            const typeInfo = `\`Type: ${componentDetail.dataType}\` \`Length: ${componentDetail.minLength}-${componentDetail.maxLength}\` \`${componentInfo.requirement}\``;
            md.appendMarkdown(`${typeInfo}\n\n`);

            // Definition
            if (componentDetail.definition) {
                md.appendMarkdown(`*${componentDetail.definition}*\n\n`);
            }

            // Current value with translation
            if (componentValue) {
                md.appendMarkdown(`**Current value:** \`${componentValue}\`\n\n`);

                // Determine if we need context-aware date validation
                const isDateComposite = compositeType && ['C507', 'S004'].includes(compositeType);
                const isDateValue = componentPosition === 2; // Component 2 is the date/time value

                let validation;
                if (isDateComposite && isDateValue && fullElementValue) {
                    // Extract format qualifier (component 3)
                    const components = fullElementValue.split(':');
                    const dateFormatQualifier = components.length >= 3 ? components[2] : undefined;

                    if (dateFormatQualifier) {
                        // Use format-aware date validation
                        validation = validateDateWithFormat(componentValue, dateFormatQualifier);
                    } else {
                        // Fallback to standard validation
                        const schema: ElementSchema = {
                            dataType: componentDetail.dataType,
                            minLength: componentDetail.minLength,
                            maxLength: componentDetail.maxLength,
                            codes: componentDetail.codes
                        };
                        validation = validateElement(componentValue, schema);
                    }
                } else {
                    // Standard element validation
                    const schema: ElementSchema = {
                        dataType: componentDetail.dataType,
                        minLength: componentDetail.minLength,
                        maxLength: componentDetail.maxLength,
                        codes: componentDetail.codes
                    };
                    validation = validateElement(componentValue, schema);
                }

                if (!validation.isValid) {
                    const icon = validation.severity === 'error' ? '❌' : '⚠️';
                    md.appendMarkdown(`${icon} **${validation.severity.charAt(0).toUpperCase() + validation.severity.slice(1)}:** ${validation.message}\n\n`);
                }

                // If this component has codes, show the translation
                if (componentDetail.codes && componentDetail.codes.length > 0) {
                    const codeTranslation = componentDetail.codes.find(c => c.code === componentValue);
                    if (codeTranslation) {
                        md.appendMarkdown(`**Translation:** ${codeTranslation.description}\n\n`);
                    }

                    // Show available codes (limit to first 10)
                    md.appendMarkdown(`**Available codes:**\n\n`);
                    const codesToShow = componentDetail.codes.slice(0, 10);
                    for (const code of codesToShow) {
                        const highlight = code.code === componentValue ? '**' : '';
                        md.appendMarkdown(`- ${highlight}\`${code.code}\`: ${code.description}${highlight}\n`);
                    }

                    if (componentDetail.codes.length > 10) {
                        md.appendMarkdown(`\n_...and ${componentDetail.codes.length - 10} more_\n`);
                    }
                }
            }
        } else {
            // Fallback if we couldn't get detailed info
            const typeInfo = `\`Element: ${componentInfo.elementId}\` \`${componentInfo.requirement}\``;
            md.appendMarkdown(`${typeInfo}\n\n`);

            if (componentValue) {
                md.appendMarkdown(`**Current value:** \`${componentValue}\`\n\n`);
            }
        }

        // Link to full reference
        md.appendMarkdown(`\n\n---\n`);
        md.appendMarkdown(`[View element reference →](https://www.stedi.com/edi/edifact/elements/${componentInfo.elementId})`);

        return md;
    }

    private createSegmentMarkdown(info: SegmentInfo, languagePrefix: string, _version: string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.isTrusted = true;

        // Header with segment code and name
        md.appendMarkdown(`### ${info.code} - ${info.name}\n\n`);

        // Description
        if (info.description) {
            md.appendMarkdown(`*${info.description}*\n\n`);
        }

        // Elements (if available and enabled in settings)
        const config = vscode.workspace.getConfiguration('ediX12Tools');
        const showElements = config.get<boolean>('hover.showElements', true);

        if (showElements && info.elements && info.elements.length > 0) {
            md.appendMarkdown(`**Elements:**\n\n`);
            for (const element of info.elements) {
                const req = element.requirement || '';
                const elemNum = element.type ? ` (${element.type})` : '';
                md.appendMarkdown(`- **${element.position}${elemNum}**: ${element.name} _(${req})_\n`);
            }

            if (info.elements.length === 10) {
                md.appendMarkdown(`\n_...and more_\n`);
            }
        }

        // Link to full reference
        md.appendMarkdown(`\n\n---\n`);
        if (languagePrefix === 'edifact') {
            md.appendMarkdown(`[View full reference →](https://www.stedi.com/edi/edifact/segments/${info.code})`);
        } else {
            md.appendMarkdown(`[View full reference →](https://www.stedi.com/edi/x12/segment/${info.code})`);
        }

        return md;
    }
}