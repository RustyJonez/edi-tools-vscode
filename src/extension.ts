import * as vscode from 'vscode';
import { StatusBarController } from './statusBar';
import { registerCommands, getDiagnosticCollection } from './commands';
import { EdiHoverProvider } from './hoverProvider';
import { EdiCodeLensProvider } from './codeLensProvider';

let statusBarController: StatusBarController | undefined;

/**
 * Auto-detect EDI language (X12 or EDIFACT) based on first line of document
 * This allows .txt and .edi files to be automatically detected and syntax highlighted correctly
 */
function detectEdiLanguage(document: vscode.TextDocument): void {
    // Only process plaintext, x12, or edifact files
    // We check x12/edifact too because .edi extension might assign the wrong one
    if (document.languageId !== 'plaintext' &&
        document.languageId !== 'x12' &&
        document.languageId !== 'edifact') {
        return;
    }

    // Don't process empty documents
    if (document.lineCount === 0) {
        return;
    }

    // Get the first line
    const firstLine = document.lineAt(0).text.trim();

    // Check for X12 format (starts with ISA)
    if (firstLine.startsWith('ISA')) {
        if (document.languageId !== 'x12') {
            vscode.languages.setTextDocumentLanguage(document, 'x12');
            console.log('[EDI Extension] Detected X12 format, switching language mode');
        }
        return;
    }

    // Check for EDIFACT format (starts with UNA or UNB)
    if (firstLine.startsWith('UNA') || firstLine.startsWith('UNB')) {
        if (document.languageId !== 'edifact') {
            vscode.languages.setTextDocumentLanguage(document, 'edifact');
            console.log('[EDI Extension] Detected EDIFACT format, switching language mode');
        }
        return;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('EDI X12 Tools extension is now active');

    // Initialize status bar controller
    statusBarController = new StatusBarController();
    context.subscriptions.push(statusBarController);

    // Register all commands
    registerCommands(context);

    // Auto-detect EDI format for .txt files based on first line
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(detectEdiLanguage),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                detectEdiLanguage(editor.document);
            }
        })
    );

    // Check currently open editors on activation
    if (vscode.window.activeTextEditor) {
        detectEdiLanguage(vscode.window.activeTextEditor.document);
    }

    // Register hover provider for X12 and EDIFACT
    const hoverProvider = new EdiHoverProvider(context.extensionPath);

    // Load schemas from local files
    console.log('[EDI Extension] Loading schemas from:', context.extensionPath);
    await hoverProvider.loadSchemas(context.extensionPath);

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            [{ language: 'x12' }, { language: 'edifact' }],
            hoverProvider
        )
    );

    // Register CodeLens provider for action buttons
    const codeLensProvider = new EdiCodeLensProvider();
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [{ language: 'x12' }, { language: 'edifact' }],
            codeLensProvider
        )
    );

    // Register diagnostic collection for validation errors
    context.subscriptions.push(getDiagnosticCollection());
}

export function deactivate() {
    if (statusBarController) {
        statusBarController.dispose();
    }
}
