import * as vscode from 'vscode';

/**
 * Provides CodeLens actions at the top of EDI documents
 * Shows buttons for: Quick Format | Lookup Transaction | Update IDs
 */
export class EdiCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor() {
        // Listen for configuration changes to refresh CodeLens
        vscode.workspace.onDidChangeConfiguration(() => {
            this._onDidChangeCodeLenses.fire();
        });
    }

    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        // Only show for EDI documents
        if (document.languageId !== 'x12' && document.languageId !== 'edifact') {
            return [];
        }

        // Detect if EDIFACT or X12
        const text = document.getText();
        const isEdifact = document.languageId === 'edifact' ||
                         text.includes('UNB+') ||
                         text.includes('UNH+') ||
                         text.includes('UNA:');

        const codeLenses: vscode.CodeLens[] = [];

        // Add CodeLens at the first line
        const topOfDocument = new vscode.Range(0, 0, 0, 0);

        // Quick Format button
        const formatCommand: vscode.Command = {
            title: '$(paintcan) Quick Format',
            tooltip: 'Normalize delimiters and add line breaks',
            command: 'ediX12Tools.quickFormat'
        };
        codeLenses.push(new vscode.CodeLens(topOfDocument, formatCommand));

        // Lookup Transaction button
        const lookupCommand: vscode.Command = {
            title: `$(search) Lookup ${isEdifact ? 'Message' : 'Transaction'}`,
            tooltip: `Open reference for ${isEdifact ? 'message type' : 'transaction set'}`,
            command: 'ediX12Tools.lookupTransactionSet'
        };
        codeLenses.push(new vscode.CodeLens(topOfDocument, lookupCommand));

        // Update IDs button (placeholder for future implementation)
        const updateIdsCommand: vscode.Command = {
            title: '$(symbol-numeric) Update IDs',
            tooltip: 'Update control numbers and identifiers (coming soon)',
            command: 'ediX12Tools.updateIds'
        };
        codeLenses.push(new vscode.CodeLens(topOfDocument, updateIdsCommand));

        return codeLenses;
    }

    public resolveCodeLens(
        codeLens: vscode.CodeLens,
        _token: vscode.CancellationToken
    ): vscode.CodeLens | Thenable<vscode.CodeLens> {
        // CodeLens is already resolved in provideCodeLenses
        return codeLens;
    }
}
