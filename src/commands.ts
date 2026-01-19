import * as vscode from 'vscode';

export function registerCommands(context: vscode.ExtensionContext): void {
    // Quick Format (combines normalize + add line breaks)
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.quickFormat', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }

            const isEdifact = editor.document.languageId === 'edifact';
            if (isEdifact) {
                await normalizeEdifactDelimiters();
                await addEdifactLineBreaks();
            } else {
                await normalizeDelimiters();
                await addLineBreaks();
            }
        })
    );

    // Normalize Delimiters
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.normalizeDelimiters', normalizeDelimiters)
    );

    // Add Line Breaks
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.addLineBreaks', addLineBreaks)
    );

    // Lookup Segment at Cursor
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.lookupSegment', lookupSegment)
    );

    // Lookup Transaction Set
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.lookupTransactionSet', lookupTransactionSet)
    );

    // Search Segment (with input)
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.searchSegment', async () => {
            const segment = await vscode.window.showInputBox({
                prompt: 'Enter segment code to search',
                placeHolder: 'ISA',
                value: 'ISA'
            });
            if (segment) {
                openSegmentReference(segment);
            }
        })
    );

    // Search Transaction Set (with input)
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.searchTransactionSet', async () => {
            const txnSet = await vscode.window.showInputBox({
                prompt: 'Enter transaction set code to search',
                placeHolder: '856',
                value: '856'
            });
            if (txnSet) {
                openTransactionSetReference(txnSet);
            }
        })
    );

    // Update IDs
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.updateIds', updateIds)
    );

    // EDIFACT-specific commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.normalizeEdifactDelimiters', normalizeEdifactDelimiters)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.addEdifactLineBreaks', addEdifactLineBreaks)
    );
}

function isEdiDocument(): boolean {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return false;
    }

    const languageId = editor.document.languageId;
    if (languageId !== 'x12' && languageId !== 'edifact') {
        vscode.window.showErrorMessage('Not an EDI document');
        return false;
    }

    return true;
}

function hasEnvelope(document: vscode.TextDocument): boolean {
    const firstLine = document.lineAt(0).text;
    return firstLine.startsWith('ISA') || firstLine.startsWith('UNB');
}

async function normalizeDelimiters(): Promise<void> {
    if (!isEdiDocument()) {
        return;
    }

    const editor = vscode.window.activeTextEditor!;
    const document = editor.document;

    if (!hasEnvelope(document)) {
        vscode.window.showWarningMessage('No envelope detected');
        return;
    }

    const text = document.getText();

    // Get delimiter positions (ISA has element delim at position 3, seg delim at position 105)
    const elemDelim = text.charAt(103);
    const segDelim = text.charAt(105);

    // Check if already normalized
    if (elemDelim === '*' && segDelim === '~') {
        const fileName = document.fileName.split('/').pop() || 'Document';
        vscode.window.setStatusBarMessage(`${fileName}: Delimiters OK - no updates made`, 3000);
        return;
    }

    let updatedText = text;

    // Use temporary placeholders to avoid conflicts when delimiters need swapping
    const tempElem = '\u0001';  // SOH (Start of Heading)
    const tempSeg = '\u0002';   // STX (Start of Text)

    // Step 1: Replace current delimiters with temp placeholders
    if (elemDelim !== '*') {
        const elemRegex = new RegExp(escapeRegExp(elemDelim), 'g');
        updatedText = updatedText.replace(elemRegex, tempElem);
    } else {
        updatedText = updatedText.replace(/\*/g, tempElem);
    }

    if (segDelim !== '~') {
        const segRegex = new RegExp(escapeRegExp(segDelim), 'g');
        updatedText = updatedText.replace(segRegex, tempSeg);
    } else {
        updatedText = updatedText.replace(/~/g, tempSeg);
    }

    // Step 2: Replace temp placeholders with standard delimiters
    updatedText = updatedText.replace(/\u0001/g, '*');  // element
    updatedText = updatedText.replace(/\u0002/g, '~');  // segment

    // Apply changes
    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    const fileName = document.fileName.split('/').pop() || 'Document';
    vscode.window.setStatusBarMessage(`${fileName}: Delimiters normalized`, 3000);
}

async function addLineBreaks(): Promise<void> {
    if (!isEdiDocument()) {
        return;
    }

    const editor = vscode.window.activeTextEditor!;
    const document = editor.document;
    const text = document.getText();

    const fileName = document.fileName.split(/[/\\]/).pop() || 'Document';

    // Count segments by counting ~ terminators
    const segmentCount = (text.match(/~/g) || []).length;
    const lineCount = text.split('\n').length;

    // Check if segments are already on separate lines
    // If line count is close to segment count, line breaks already exist
    if (segmentCount > 0 && lineCount >= segmentCount * 0.9) {
        vscode.window.setStatusBarMessage(`${fileName}: Line breaks already present`, 3000);
        return;
    }

    // Add line breaks after segment terminators (~)
    // But don't add duplicate line breaks if one already exists
    const updatedText = text.replace(/~\n?/g, '~\n');

    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    vscode.window.setStatusBarMessage(`${fileName}: Line breaks added`, 3000);
}

function lookupSegment(): void {
    if (!isEdiDocument()) {
        return;
    }

    const editor = vscode.window.activeTextEditor!;
    const position = editor.selection.active;
    const line = editor.document.lineAt(position.line);
    const lineText = line.text;

    // Extract segment code (first 2-3 characters)
    const segmentMatch = lineText.match(/^([A-Z0-9]{2,3})/);
    if (!segmentMatch) {
        vscode.window.showWarningMessage('No segment found at cursor');
        return;
    }

    const segment = segmentMatch[1];
    openSegmentReference(segment);
}

function lookupTransactionSet(): void {
    if (!isEdiDocument()) {
        return;
    }

    const editor = vscode.window.activeTextEditor!;
    const text = editor.document.getText();
    const languageId = editor.document.languageId;

    // Detect if EDIFACT or X12
    let isEdifact = false;
    if (languageId === 'edifact') {
        isEdifact = true;
    } else if (languageId === 'x12') {
        isEdifact = false;
    } else {
        // Detect from content
        isEdifact = text.includes('UNB+') || text.includes('UNH+') || text.includes('UNA:');
    }

    let txnSet: string | undefined;

    if (isEdifact) {
        // EDIFACT: Look for UNH segment with message type
        // Format: UNH+reference+ORDERS:D:96A:UN'
        // Message type is the first part after the second +
        const unhMatch = text.match(/UNH\+[^+]+\+([A-Z]+):/);
        if (unhMatch) {
            txnSet = unhMatch[1];
        }
    } else {
        // X12: Look for ST segment with transaction set code
        // Format: ST*850*0001
        const stMatch = text.match(/\nST\*(\w+)/);
        if (stMatch) {
            txnSet = stMatch[1];
        }
    }

    if (!txnSet) {
        vscode.window.showWarningMessage(`No ${isEdifact ? 'message type' : 'transaction set'} found in file`);
        return;
    }

    openTransactionSetReference(txnSet);
}

function openSegmentReference(segment: string): void {
    // Detect if current document is EDIFACT or X12
    const editor = vscode.window.activeTextEditor;
    let isEdifact = false;

    if (editor) {
        const languageId = editor.document.languageId;
        if (languageId === 'edifact') {
            isEdifact = true;
        } else if (languageId === 'x12') {
            isEdifact = false;
        } else {
            // Try to detect from content if language not set
            const text = editor.document.getText();
            isEdifact = text.includes('UNB+') || text.includes('UNH+') || text.includes('UNA:');
        }
    }

    const url = isEdifact
        ? `https://www.stedi.com/edi/edifact/segments/${segment}`
        : `https://www.stedi.com/edi/x12/segment/${segment}`;

    vscode.env.openExternal(vscode.Uri.parse(url));
    vscode.window.showInformationMessage(`Opening reference for segment ${segment}...`);
}

function openTransactionSetReference(txnSet: string): void {
    // Detect if current document is EDIFACT or X12
    const editor = vscode.window.activeTextEditor;
    let isEdifact = false;

    if (editor) {
        const languageId = editor.document.languageId;
        if (languageId === 'edifact') {
            isEdifact = true;
        } else if (languageId === 'x12') {
            isEdifact = false;
        } else {
            // Try to detect from content if language not set
            const text = editor.document.getText();
            isEdifact = text.includes('UNB+') || text.includes('UNH+') || text.includes('UNA:');
        }
    }

    const url = isEdifact
        ? `https://www.stedi.com/edi/edifact/messages/${txnSet}`
        : `https://www.stedi.com/edi/x12/transaction-set/${txnSet}`;

    vscode.env.openExternal(vscode.Uri.parse(url));
    vscode.window.showInformationMessage(`Opening reference for ${isEdifact ? 'message' : 'transaction set'} ${txnSet}...`);
}

/**
 * Normalize EDIFACT delimiters to standard format
 * Standard EDIFACT: + (element), : (component), ' (segment), ? (release/escape)
 */
async function normalizeEdifactDelimiters(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const fileName = document.fileName.split(/[/\\]/).pop() || 'Document';

    // Check for UNA (EDIFACT service string advice)
    // UNA:+.? ' defines: component(:), element(+), decimal(.), release(?), segment(')
    let componentDelim = ':';
    let elementDelim = '+';
    let segmentDelim = "'";
    let releaseChar = '?';

    if (text.startsWith('UNA')) {
        // UNA is always 9 characters: UNA followed by 6 delimiter characters
        componentDelim = text.charAt(3);
        elementDelim = text.charAt(4);
        // decimal separator at position 5 (not needed for normalization)
        releaseChar = text.charAt(6);
        // reserved at position 7
        segmentDelim = text.charAt(8);
    } else if (text.startsWith('UNB')) {
        // No UNA - use default delimiters, infer from UNB structure
        // UNB+UNOA:2+... (element=+, component=:, segment=')
        const unbMatch = text.match(/^UNB(.)/);
        if (unbMatch) {
            elementDelim = unbMatch[1];
        }
        const componentMatch = text.match(/^UNB[^:]*(.)/);
        if (componentMatch) {
            componentDelim = componentMatch[1];
        }
        // Find segment terminator (should be after first UNB segment)
        const segMatch = text.match(/^UNB[^\n]*?(.)\n/);
        if (segMatch) {
            segmentDelim = segMatch[1];
        } else {
            // Try to find it without newline
            const segMatch2 = text.match(/^UNB[^']*?(')/);
            if (segMatch2) {
                segmentDelim = segMatch2[1];
            }
        }
    } else {
        vscode.window.showWarningMessage('No EDIFACT envelope (UNA/UNB) detected');
        return;
    }

    // Check if already normalized
    if (componentDelim === ':' && elementDelim === '+' && segmentDelim === "'" && releaseChar === '?') {
        vscode.window.setStatusBarMessage(`${fileName}: Delimiters OK - no updates made`, 3000);
        return;
    }

    let updatedText = text;

    // Replace delimiters in careful order to avoid conflicts
    // Use temporary placeholders to prevent double-replacement

    // Step 1: Replace all to temp placeholders
    const tempComponent = '\u0001';  // SOH
    const tempElement = '\u0002';    // STX
    const tempSegment = '\u0003';    // ETX
    const tempRelease = '\u0004';    // EOT

    if (componentDelim !== ':') {
        const regex = new RegExp(escapeRegExp(componentDelim), 'g');
        updatedText = updatedText.replace(regex, tempComponent);
    } else {
        updatedText = updatedText.replace(/:/g, tempComponent);
    }

    if (elementDelim !== '+') {
        const regex = new RegExp(escapeRegExp(elementDelim), 'g');
        updatedText = updatedText.replace(regex, tempElement);
    } else {
        updatedText = updatedText.replace(/\+/g, tempElement);
    }

    if (segmentDelim !== "'") {
        const regex = new RegExp(escapeRegExp(segmentDelim), 'g');
        updatedText = updatedText.replace(regex, tempSegment);
    } else {
        updatedText = updatedText.replace(/'/g, tempSegment);
    }

    if (releaseChar !== '?') {
        const regex = new RegExp(escapeRegExp(releaseChar), 'g');
        updatedText = updatedText.replace(regex, tempRelease);
    } else {
        updatedText = updatedText.replace(/\?/g, tempRelease);
    }

    // Step 2: Replace temp placeholders with standard delimiters
    updatedText = updatedText.replace(/\u0001/g, ':');  // component
    updatedText = updatedText.replace(/\u0002/g, '+');  // element
    updatedText = updatedText.replace(/\u0003/g, "'");  // segment
    updatedText = updatedText.replace(/\u0004/g, '?');  // release

    // Step 3: Update or add UNA header
    if (text.startsWith('UNA')) {
        // Replace existing UNA with normalized version
        updatedText = "UNA:+.? '" + updatedText.substring(9);
    } else {
        // Prepend UNA if not present
        updatedText = "UNA:+.? '\n" + updatedText;
    }

    // Apply changes
    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    vscode.window.setStatusBarMessage(`${fileName}: EDIFACT delimiters normalized`, 3000);
}

/**
 * Add line breaks after EDIFACT segment terminators
 */
async function addEdifactLineBreaks(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const document = editor.document;
    const text = document.getText();
    const fileName = document.fileName.split(/[/\\]/).pop() || 'Document';

    // Determine segment terminator (default is ', but check UNA if present)
    let segmentDelim = "'";
    if (text.startsWith('UNA')) {
        segmentDelim = text.charAt(8);
    }

    // Count segments by counting segment terminators
    const escapedDelim = escapeRegExp(segmentDelim);
    const segmentCount = (text.match(new RegExp(escapedDelim, 'g')) || []).length;
    const lineCount = text.split('\n').length;

    // Check if segments are already on separate lines
    // If line count is close to segment count, line breaks already exist
    if (segmentCount > 0 && lineCount >= segmentCount * 0.9) {
        vscode.window.setStatusBarMessage(`${fileName}: Line breaks already present`, 3000);
        return;
    }

    // Add line breaks after segment terminators
    // But don't add duplicate line breaks if one already exists
    const regex = new RegExp(escapedDelim + '\\n?', 'g');
    const updatedText = text.replace(regex, `${segmentDelim}\n`);

    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    vscode.window.setStatusBarMessage(`${fileName}: Line breaks added`, 3000);
}

/**
 * Update sender/receiver IDs in EDI documents
 * Supports both X12 (ISA/GS) and EDIFACT (UNB) formats
 */
async function updateIds(): Promise<void> {
    if (!isEdiDocument()) {
        return;
    }

    const editor = vscode.window.activeTextEditor!;
    const document = editor.document;
    const text = document.getText();
    const languageId = document.languageId;

    // Detect document type
    const isEdifact = languageId === 'edifact' ||
        text.includes('UNB+') || text.includes('UNH+') || text.includes('UNA:');

    if (isEdifact) {
        await updateEdifactIds(editor, text);
    } else {
        await updateX12Ids(editor, text);
    }
}

/**
 * Update X12 ISA/GS sender and receiver IDs
 */
async function updateX12Ids(editor: vscode.TextEditor, text: string): Promise<void> {
    const document = editor.document;
    const fileName = document.fileName.split(/[/\\]/).pop() || 'Document';

    // Check for ISA envelope
    if (!text.startsWith('ISA')) {
        vscode.window.showWarningMessage('No ISA envelope detected');
        return;
    }

    // Detect delimiters
    const elemDelim = text.charAt(3);

    // Ask user what to update
    const updateChoice = await vscode.window.showQuickPick(
        [
            { label: 'Sender', description: 'Update sender qualifier and ID (ISA-05/06, GS-02)' },
            { label: 'Receiver', description: 'Update receiver qualifier and ID (ISA-07/08, GS-03)' },
            { label: 'Both', description: 'Update both sender and receiver' }
        ],
        { placeHolder: 'What would you like to update?' }
    );

    if (!updateChoice) {
        return;
    }

    const updateSender = updateChoice.label === 'Sender' || updateChoice.label === 'Both';
    const updateReceiver = updateChoice.label === 'Receiver' || updateChoice.label === 'Both';

    let senderQual = '', senderId = '', senderGsId = '';
    let receiverQual = '', receiverId = '', receiverGsId = '';

    // Get sender values
    if (updateSender) {
        const senderQualInput = await vscode.window.showInputBox({
            prompt: 'Enter sender qualifier (2 characters, e.g., 01, ZZ, 14)',
            placeHolder: 'ZZ',
            validateInput: (value) => {
                if (value.length !== 2) {
                    return 'Qualifier must be exactly 2 characters';
                }
                return null;
            }
        });
        if (senderQualInput === undefined) { return; }
        senderQual = senderQualInput;

        const senderIdInput = await vscode.window.showInputBox({
            prompt: 'Enter sender ISA ID (1-15 characters)',
            placeHolder: 'SENDERID',
            validateInput: (value) => {
                if (value.length < 1 || value.length > 15) {
                    return 'ID must be 1-15 characters';
                }
                if (/[^\w\d \-]/.test(value)) {
                    return 'ID can only contain letters, numbers, spaces, and hyphens';
                }
                return null;
            }
        });
        if (senderIdInput === undefined) { return; }
        senderId = senderIdInput.padEnd(15, ' ');

        const senderGsIdInput = await vscode.window.showInputBox({
            prompt: 'Enter sender GS ID (2-15 characters)',
            placeHolder: senderIdInput.trim(),
            value: senderIdInput.trim(),
            validateInput: (value) => {
                if (value.length < 2 || value.length > 15) {
                    return 'GS ID must be 2-15 characters';
                }
                return null;
            }
        });
        if (senderGsIdInput === undefined) { return; }
        senderGsId = senderGsIdInput;
    }

    // Get receiver values
    if (updateReceiver) {
        const receiverQualInput = await vscode.window.showInputBox({
            prompt: 'Enter receiver qualifier (2 characters, e.g., 01, ZZ, 14)',
            placeHolder: 'ZZ',
            validateInput: (value) => {
                if (value.length !== 2) {
                    return 'Qualifier must be exactly 2 characters';
                }
                return null;
            }
        });
        if (receiverQualInput === undefined) { return; }
        receiverQual = receiverQualInput;

        const receiverIdInput = await vscode.window.showInputBox({
            prompt: 'Enter receiver ISA ID (1-15 characters)',
            placeHolder: 'RECEIVERID',
            validateInput: (value) => {
                if (value.length < 1 || value.length > 15) {
                    return 'ID must be 1-15 characters';
                }
                if (/[^\w\d \-]/.test(value)) {
                    return 'ID can only contain letters, numbers, spaces, and hyphens';
                }
                return null;
            }
        });
        if (receiverIdInput === undefined) { return; }
        receiverId = receiverIdInput.padEnd(15, ' ');

        const receiverGsIdInput = await vscode.window.showInputBox({
            prompt: 'Enter receiver GS ID (2-15 characters)',
            placeHolder: receiverIdInput.trim(),
            value: receiverIdInput.trim(),
            validateInput: (value) => {
                if (value.length < 2 || value.length > 15) {
                    return 'GS ID must be 2-15 characters';
                }
                return null;
            }
        });
        if (receiverGsIdInput === undefined) { return; }
        receiverGsId = receiverGsIdInput;
    }

    let updatedText = text;
    const escapedDelim = escapeRegExp(elemDelim);

    // Update ISA sender (positions: qual at element 5, ID at element 6)
    // ISA*00*          *00*          *ZZ*SENDERID       *...
    if (updateSender) {
        const isaSenderPattern = new RegExp(
            `(ISA${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim})([^${escapedDelim}]{1,2})(${escapedDelim})([^${escapedDelim}]{1,15})`,
            'g'
        );
        updatedText = updatedText.replace(isaSenderPattern, `$1${senderQual}$3${senderId}`);

        // Update GS sender (element 2)
        // GS*PO*SENDERID*RECEIVERID*...
        const gsSenderPattern = new RegExp(
            `(GS${escapedDelim}[^${escapedDelim}]*${escapedDelim})([^${escapedDelim}]{2,15})(${escapedDelim})`,
            'g'
        );
        updatedText = updatedText.replace(gsSenderPattern, `$1${senderGsId}$3`);
    }

    // Update ISA receiver (positions: qual at element 7, ID at element 8)
    if (updateReceiver) {
        const isaReceiverPattern = new RegExp(
            `(ISA${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim})([^${escapedDelim}]{1,2})(${escapedDelim})([^${escapedDelim}]{1,15})`,
            'g'
        );
        updatedText = updatedText.replace(isaReceiverPattern, `$1${receiverQual}$3${receiverId}`);

        // Update GS receiver (element 3)
        const gsReceiverPattern = new RegExp(
            `(GS${escapedDelim}[^${escapedDelim}]*${escapedDelim}[^${escapedDelim}]*${escapedDelim})([^${escapedDelim}]{2,15})(${escapedDelim})`,
            'g'
        );
        updatedText = updatedText.replace(gsReceiverPattern, `$1${receiverGsId}$3`);
    }

    // Apply changes
    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    const updated = updateSender && updateReceiver ? 'sender and receiver' :
                    updateSender ? 'sender' : 'receiver';
    vscode.window.setStatusBarMessage(`${fileName}: Updated ${updated} IDs`, 3000);
}

/**
 * Update EDIFACT UNB sender and receiver IDs
 */
async function updateEdifactIds(editor: vscode.TextEditor, text: string): Promise<void> {
    const document = editor.document;
    const fileName = document.fileName.split(/[/\\]/).pop() || 'Document';

    // Detect delimiters from UNA or defaults
    let elementDelim = '+';
    let componentDelim = ':';

    if (text.startsWith('UNA')) {
        componentDelim = text.charAt(3);
        elementDelim = text.charAt(4);
    }

    // Check for UNB envelope
    if (!text.includes('UNB' + elementDelim)) {
        vscode.window.showWarningMessage('No UNB envelope detected');
        return;
    }

    // Ask user what to update
    const updateChoice = await vscode.window.showQuickPick(
        [
            { label: 'Sender', description: 'Update sender ID and qualifier (UNB element 2)' },
            { label: 'Receiver', description: 'Update receiver ID and qualifier (UNB element 3)' },
            { label: 'Both', description: 'Update both sender and receiver' }
        ],
        { placeHolder: 'What would you like to update?' }
    );

    if (!updateChoice) {
        return;
    }

    const updateSender = updateChoice.label === 'Sender' || updateChoice.label === 'Both';
    const updateReceiver = updateChoice.label === 'Receiver' || updateChoice.label === 'Both';

    let senderId = '', senderQual: string | null = null;
    let receiverId = '', receiverQual: string | null = null;

    // Get sender values
    if (updateSender) {
        const senderIdInput = await vscode.window.showInputBox({
            prompt: 'Enter sender ID (1-35 characters)',
            placeHolder: 'SENDERID',
            validateInput: (value) => {
                if (value.length < 1 || value.length > 35) {
                    return 'ID must be 1-35 characters';
                }
                return null;
            }
        });
        if (senderIdInput === undefined) { return; }
        senderId = senderIdInput;

        const senderQualInput = await vscode.window.showInputBox({
            prompt: 'Enter sender qualifier (0-4 characters, leave blank to remove)',
            placeHolder: '14 (or leave blank)',
            validateInput: (value) => {
                if (value.length > 4) {
                    return 'Qualifier must be 0-4 characters';
                }
                return null;
            }
        });
        if (senderQualInput === undefined) { return; }
        senderQual = senderQualInput || null;
    }

    // Get receiver values
    if (updateReceiver) {
        const receiverIdInput = await vscode.window.showInputBox({
            prompt: 'Enter receiver ID (1-35 characters)',
            placeHolder: 'RECEIVERID',
            validateInput: (value) => {
                if (value.length < 1 || value.length > 35) {
                    return 'ID must be 1-35 characters';
                }
                return null;
            }
        });
        if (receiverIdInput === undefined) { return; }
        receiverId = receiverIdInput;

        const receiverQualInput = await vscode.window.showInputBox({
            prompt: 'Enter receiver qualifier (0-4 characters, leave blank to remove)',
            placeHolder: '14 (or leave blank)',
            validateInput: (value) => {
                if (value.length > 4) {
                    return 'Qualifier must be 0-4 characters';
                }
                return null;
            }
        });
        if (receiverQualInput === undefined) { return; }
        receiverQual = receiverQualInput || null;
    }

    // Parse and update UNB segment
    const escapedElemDelim = escapeRegExp(elementDelim);

    // Find UNB segment
    const unbPattern = new RegExp(`UNB${escapedElemDelim}[^']*'`, 'g');
    const unbMatch = text.match(unbPattern);

    if (!unbMatch) {
        vscode.window.showWarningMessage('Could not parse UNB segment');
        return;
    }

    let unbSegment = unbMatch[0];
    const unbElements = unbSegment.slice(0, -1).split(elementDelim); // Remove trailing ' and split

    // UNB structure: UNB+syntax+sender+receiver+datetime+ref+...
    // Element 0: UNB
    // Element 1: Syntax identifier (e.g., UNOA:2)
    // Element 2: Sender (ID:Qualifier or just ID)
    // Element 3: Receiver (ID:Qualifier or just ID)

    if (updateSender && unbElements.length > 2) {
        unbElements[2] = senderQual ? `${senderId}${componentDelim}${senderQual}` : senderId;
    }

    if (updateReceiver && unbElements.length > 3) {
        unbElements[3] = receiverQual ? `${receiverId}${componentDelim}${receiverQual}` : receiverId;
    }

    const newUnbSegment = unbElements.join(elementDelim) + "'";
    const updatedText = text.replace(unbMatch[0], newUnbSegment);

    // Apply changes
    await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );
        editBuilder.replace(fullRange, updatedText);
    });

    const updated = updateSender && updateReceiver ? 'sender and receiver' :
                    updateSender ? 'sender' : 'receiver';
    vscode.window.setStatusBarMessage(`${fileName}: Updated ${updated} IDs`, 3000);
}

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
