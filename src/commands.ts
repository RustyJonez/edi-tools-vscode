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

    // Validate Document
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.validateDocument', validateDocument)
    );

    // Clear Validation
    context.subscriptions.push(
        vscode.commands.registerCommand('ediX12Tools.clearValidation', clearValidation)
    );

    // Clear diagnostics on document close
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            getDiagnosticCollection().delete(doc.uri);
        })
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
    let updatedText = text.replace(unbMatch[0], newUnbSegment);

    // Also update UNG segment(s) if present
    // UNG is the functional group header and uses the same sender/receiver IDs
    // UNG structure: UNG+group_id+sender+receiver+datetime+ref+...
    const ungPattern = new RegExp(`UNG${escapedElemDelim}[^']*'`, 'g');
    const ungMatches = text.match(ungPattern);

    if (ungMatches && ungMatches.length > 0) {
        // Update all UNG segments found
        for (const ungMatch of ungMatches) {
            const ungElements = ungMatch.slice(0, -1).split(elementDelim);

            // UNG Element 2: Sender, Element 3: Receiver
            if (updateSender && ungElements.length > 2) {
                ungElements[2] = senderQual ? `${senderId}${componentDelim}${senderQual}` : senderId;
            }

            if (updateReceiver && ungElements.length > 3) {
                ungElements[3] = receiverQual ? `${receiverId}${componentDelim}${receiverQual}` : receiverId;
            }

            const newUngSegment = ungElements.join(elementDelim) + "'";
            updatedText = updatedText.replace(ungMatch, newUngSegment);
        }
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

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Diagnostic collection for validation errors
let diagnosticCollection: vscode.DiagnosticCollection | undefined;

/**
 * Get or create the diagnostic collection
 */
export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    if (!diagnosticCollection) {
        diagnosticCollection = vscode.languages.createDiagnosticCollection('edi');
    }
    return diagnosticCollection;
}

/**
 * Validate the current EDI document and show diagnostics
 */
async function validateDocument(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    const document = editor.document;
    const languageId = document.languageId;
    const text = document.getText();

    // Detect document type from languageId or content
    let isEdifact = false;
    if (languageId === 'edifact') {
        isEdifact = true;
    } else if (languageId === 'x12') {
        isEdifact = false;
    } else {
        // Try to detect from content
        if (text.startsWith('UNA') || text.startsWith('UNB') || text.includes('UNH+')) {
            isEdifact = true;
        } else if (text.startsWith('ISA')) {
            isEdifact = false;
        } else {
            vscode.window.showErrorMessage('Not an EDI document (no ISA or UNB/UNH envelope found)');
            return;
        }
    }
    const diagnostics: vscode.Diagnostic[] = [];

    // Import validators dynamically to avoid circular dependencies
    const { validateElement, validateDateWithFormat } = await import('./validators');

    // Load schemas - we need to access them for validation
    const fs = await import('fs');
    const path = await import('path');

    // Get extension path - try extension API first, fallback to __dirname
    const extension = vscode.extensions.getExtension('RustyJonez.edi-tools');
    const extensionPath = extension?.extensionPath || path.join(__dirname, '..');

    console.log(`[EDI Validate] Extension path: ${extensionPath}`);

    // Detect version
    let version = isEdifact ? detectEdifactVersionFromDoc(document) : detectX12VersionFromDoc(document);
    let schemaDir = path.join(extensionPath, 'schemas', isEdifact ? 'edifact' : 'x12', version);

    // Fallback to common versions if detected version doesn't exist
    if (!fs.existsSync(schemaDir)) {
        console.log(`[EDI Validate] Version ${version} not found, trying fallbacks...`);
        const fallbackVersions = isEdifact
            ? ['d96a', 'd01b', 'd03a', 'd98b', 'd21a']
            : ['004010', '005010', '008010', '003070', '003060', '003010', '007020'];

        for (const fallback of fallbackVersions) {
            const fallbackDir = path.join(extensionPath, 'schemas', isEdifact ? 'edifact' : 'x12', fallback);
            if (fs.existsSync(fallbackDir)) {
                console.log(`[EDI Validate] Using fallback version: ${fallback}`);
                version = fallback;
                schemaDir = fallbackDir;
                break;
            }
        }
    }

    console.log(`[EDI Validate] Schema dir: ${schemaDir}`);
    console.log(`[EDI Validate] Version: ${version}, isEdifact: ${isEdifact}`);

    // Load segment and element schemas
    let segments: Record<string, any> = {};
    let elements: Record<string, any> = {};
    let composites: Record<string, any> = {};

    const segmentsPath = path.join(schemaDir, 'segments.json');
    const elementsPath = path.join(schemaDir, 'elements.json');
    const compositesPath = path.join(schemaDir, 'composites.json');

    console.log(`[EDI Validate] Segments path exists: ${fs.existsSync(segmentsPath)}`);
    console.log(`[EDI Validate] Elements path exists: ${fs.existsSync(elementsPath)}`);

    if (fs.existsSync(segmentsPath)) {
        segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
        console.log(`[EDI Validate] Loaded ${Object.keys(segments).length} segments`);
    }
    if (fs.existsSync(elementsPath)) {
        elements = JSON.parse(fs.readFileSync(elementsPath, 'utf-8'));
        console.log(`[EDI Validate] Loaded ${Object.keys(elements).length} elements`);
    }
    if (isEdifact && fs.existsSync(compositesPath)) {
        composites = JSON.parse(fs.readFileSync(compositesPath, 'utf-8'));
        console.log(`[EDI Validate] Loaded ${Object.keys(composites).length} composites`);
    }

    const delimiter = isEdifact ? '+' : '*';

    // Validate each line (segment)
    for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
        const line = document.lineAt(lineNum);
        const lineText = line.text;

        if (!lineText.trim()) continue;

        // Extract segment code
        const segmentMatch = lineText.match(/^([A-Z0-9]{2,3})(?=\*|\+|:)/);
        if (!segmentMatch) {
            continue;
        }

        const segmentCode = segmentMatch[1];
        const segmentInfo = segments[segmentCode];

        if (!segmentInfo || !segmentInfo.elements) {
            continue;
        }

        // Parse elements
        const parts = lineText.split(delimiter);
        let currentPos = segmentCode.length;

        for (let i = 1; i < parts.length && i <= segmentInfo.elements.length; i++) {
            currentPos++; // Account for delimiter
            const elementStart = currentPos;

            // Remove segment terminator from last element
            let elementValue = parts[i];
            if (i === parts.length - 1) {
                elementValue = elementValue.replace(/[~'\n\r]+$/g, '');
            }

            const elementEnd = elementStart + elementValue.length;
            currentPos = elementStart + parts[i].length;

            // Skip empty elements
            if (!elementValue.trim()) continue;

            // Get element schema
            const elementInfo = segmentInfo.elements[i - 1];
            if (!elementInfo) {
                continue;
            }

            // Check if this is a composite or simple element
            // Composites have types like C001, S001, etc.
            const compositeInfo = isEdifact ? composites[elementInfo.type] : null;
            const elementDetail = elements[elementInfo.type];

            // For EDIFACT, prioritize composites over simple elements
            if (compositeInfo) {
                // Check if this is a single-component composite (no colons) or multi-component
                const isSingleComponent = !elementValue.includes(':');

                if (isSingleComponent && compositeInfo.components && compositeInfo.components.length > 0) {
                    // Single component - validate against first component's schema
                    const componentInfo = compositeInfo.components[0];
                    const componentDetail = elements[componentInfo.elementId];

                    if (componentDetail && elementValue.trim()) {
                        const componentSchema = {
                            dataType: componentDetail.dataType || 'AN',
                            minLength: componentDetail.minLength || 0,
                            maxLength: componentDetail.maxLength || 999,
                            codes: componentDetail.codes
                        };
                        const validation = validateElement(elementValue, componentSchema);

                        if (!validation.isValid) {
                            const range = new vscode.Range(lineNum, elementStart, lineNum, elementEnd);
                            const severity = validation.severity === 'error'
                                ? vscode.DiagnosticSeverity.Error
                                : vscode.DiagnosticSeverity.Warning;

                            const diagnostic = new vscode.Diagnostic(range, validation.message, severity);
                            diagnostic.source = 'EDI Validator';
                            diagnostic.code = validation.errorType;
                            diagnostics.push(diagnostic);
                        }
                    }
                } else {
                    // Multi-component composite - validate each component
                    const components = elementValue.split(':');
                    let compPos = elementStart;

                    // Check if this is a date/time composite (C507, S004, etc.) and extract format qualifier
                    const isDateComposite = ['C507', 'S004'].includes(elementInfo.type);
                    const dateFormatQualifier = isDateComposite && components.length >= 3 ? components[2] : undefined;

                    for (let c = 0; c < components.length; c++) {
                        const compValue = components[c];
                        const compEnd = compPos + compValue.length;

                        if (compValue.trim() && compositeInfo.components && c < compositeInfo.components.length) {
                            const componentInfo = compositeInfo.components[c];
                            const componentDetail = elements[componentInfo.elementId];

                            if (componentDetail) {
                                let validation;

                                // Special handling for date/time values in date composites
                                // Component 2 (index 1) is the actual date/time value
                                if (isDateComposite && c === 1 && dateFormatQualifier) {
                                    // Use format-aware date validation
                                    validation = validateDateWithFormat(compValue, dateFormatQualifier);
                                } else {
                                    // Standard element validation
                                    const componentSchema = {
                                        dataType: componentDetail.dataType || 'AN',
                                        minLength: componentDetail.minLength || 0,
                                        maxLength: componentDetail.maxLength || 999,
                                        codes: componentDetail.codes
                                    };
                                    validation = validateElement(compValue, componentSchema);
                                }

                                if (!validation.isValid) {
                                    const range = new vscode.Range(lineNum, compPos, lineNum, compEnd);
                                    const severity = validation.severity === 'error'
                                        ? vscode.DiagnosticSeverity.Error
                                        : vscode.DiagnosticSeverity.Warning;

                                    const diagnostic = new vscode.Diagnostic(range, validation.message, severity);
                                    diagnostic.source = 'EDI Validator';
                                    diagnostic.code = validation.errorType;
                                    diagnostics.push(diagnostic);
                                }
                            }
                        }

                        compPos = compEnd + 1; // +1 for ':'
                    }
                }
            } else if (elementDetail) {
                // This is a simple element
                const validation = validateElement(elementValue, {
                    dataType: elementDetail.dataType || 'AN',
                    minLength: elementDetail.minLength || 0,
                    maxLength: elementDetail.maxLength || 999,
                    codes: elementDetail.codes
                });

                if (!validation.isValid) {
                    const range = new vscode.Range(lineNum, elementStart, lineNum, elementEnd);
                    const severity = validation.severity === 'error'
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning;

                    const diagnostic = new vscode.Diagnostic(range, validation.message, severity);
                    diagnostic.source = 'EDI Validator';
                    diagnostic.code = validation.errorType;
                    diagnostics.push(diagnostic);
                }
            }
        }
    }

    // Set diagnostics
    const collection = getDiagnosticCollection();
    collection.set(document.uri, diagnostics);

    // Show Problems panel if there are diagnostics
    if (diagnostics.length > 0) {
        vscode.commands.executeCommand('workbench.actions.view.problems');
    }

    // Show summary
    const errorCount = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
    const warningCount = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('EDI Validation: No issues found');
    } else {
        vscode.window.showWarningMessage(`EDI Validation: ${errorCount} error(s), ${warningCount} warning(s)`);
    }
}

/**
 * Clear validation errors for the current document
 */
function clearValidation(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    const document = editor.document;
    const collection = getDiagnosticCollection();
    collection.delete(document.uri);

    vscode.window.showInformationMessage('EDI Validation: Cleared all issues');
}

/**
 * Detect EDIFACT version from document
 */
function detectEdifactVersionFromDoc(document: vscode.TextDocument): string {
    const lineCount = Math.min(20, document.lineCount);
    for (let i = 0; i < lineCount; i++) {
        const line = document.lineAt(i).text;
        const unhMatch = line.match(/^UNH\+[^+]+\+[^:]+:D:(\d{2}[AB]):UN/i);
        if (unhMatch) {
            return 'd' + unhMatch[1].toLowerCase();
        }
    }
    return 'd96a'; // Default fallback
}

/**
 * Detect X12 version from document
 */
function detectX12VersionFromDoc(document: vscode.TextDocument): string {
    if (document.lineCount > 0) {
        const firstLine = document.lineAt(0).text;
        if (firstLine.startsWith('ISA') && firstLine.length >= 89) {
            const isaVersion = firstLine.substring(84, 89).trim();
            // Convert 5-char format (00401) to 6-char format (004010)
            let version = isaVersion.length === 5 ? isaVersion + '0' : isaVersion;

            // Map common version variations to available schemas
            // e.g., 004000 -> 004010 (closest match)
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
                console.log(`[EDI Validate] Mapping version ${version} to ${versionMappings[version]}`);
                version = versionMappings[version];
            }

            return version;
        }
    }
    return '004010'; // Default fallback
}
