import * as vscode from 'vscode';
import { StatusBarController } from './statusBar';
import { registerCommands } from './commands';
import { EdiHoverProvider } from './hoverProvider';
import { EdiCodeLensProvider } from './codeLensProvider';

let statusBarController: StatusBarController | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log('EDI X12 Tools extension is now active');

    // Initialize status bar controller
    statusBarController = new StatusBarController();
    context.subscriptions.push(statusBarController);

    // Register all commands
    registerCommands(context);

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
}

export function deactivate() {
    if (statusBarController) {
        statusBarController.dispose();
    }
}
