import * as vscode from 'vscode';

export class StatusBarController {
    private statusBarItem: vscode.StatusBarItem;
    private hoverToggleItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];

    constructor() {
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.disposables.push(this.statusBarItem);

        // Create hover toggle button (high priority = leftmost item in the right-side cluster)
        this.hoverToggleItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            10000
        );
        this.hoverToggleItem.command = 'ediX12Tools.toggleHover';
        this.disposables.push(this.hoverToggleItem);

        // Refresh the toggle button when the setting changes (from the button, command palette, or settings UI)
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('ediX12Tools.hover.enabled')) {
                    this.updateStatusBar();
                }
            })
        );

        // Register event handlers
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(
                this.updateStatusBar,
                this
            )
        );
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(
                this.updateStatusBar,
                this
            )
        );

        // Initial update
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            this.statusBarItem.hide();
            this.hoverToggleItem.hide();
            return;
        }

        const document = editor.document;
        const languageId = document.languageId;

        // Only show for X12 or EDIFACT files
        if (languageId !== 'x12' && languageId !== 'edifact') {
            this.statusBarItem.hide();
            this.hoverToggleItem.hide();
            return;
        }

        this.updateHoverToggle();

        const position = editor.selection.active;
        const positionInfo = this.getSegmentElementPosition(editor, position);

        if (positionInfo) {
            this.statusBarItem.text = positionInfo;
            this.statusBarItem.show();
        } else {
            this.statusBarItem.text = languageId.toUpperCase();
            this.statusBarItem.show();
        }
    }

    private updateHoverToggle(): void {
        const enabled = vscode.workspace
            .getConfiguration('ediX12Tools')
            .get<boolean>('hover.enabled', true);

        this.hoverToggleItem.text = enabled ? '$(eye) Hover' : '$(eye-closed) Hover';
        this.hoverToggleItem.tooltip = enabled
            ? 'EDI hover tooltips: On (click to turn off)'
            : 'EDI hover tooltips: Off (click to turn on)';
        this.hoverToggleItem.show();
    }

    private getSegmentElementPosition(
        editor: vscode.TextEditor,
        position: vscode.Position
    ): string | null {
        const document = editor.document;
        const line = document.lineAt(position.line);
        const lineText = line.text;
        const cursorOffset = position.character;

        // Handle multi-line selections
        if (!lineText) {
            return null;
        }

        // Get segment delimiter (usually ~ for X12, ' for EDIFACT)
        const isEdifact = document.languageId === 'edifact';
        const elementDelim = isEdifact ? '+' : '*';

        // Extract segment name (first 2-3 characters before first delimiter)
        const segmentMatch = lineText.match(/^([A-Z0-9]{2,3})(?=\\*|\\+|\\:)/);
        if (!segmentMatch) {
            return null;
        }

        const segment = segmentMatch[1];

        // Count element delimiters before cursor position
        const textBeforeCursor = lineText.substring(0, cursorOffset);
        const elementCount = (textBeforeCursor.match(new RegExp('\\' + elementDelim, 'g')) || []).length;

        // Check if selection spans multiple elements
        const selection = document.getText(
            new vscode.Range(
                editor.selection.start,
                editor.selection.end
            )
        );
        const hasMultipleElements = selection.includes(elementDelim);
        const hasMultipleLines = selection.includes('\n');

        if (hasMultipleLines) {
            return document.languageId.toUpperCase();
        }

        if (hasMultipleElements) {
            return segment;
        }

        // Format element count with leading zero if less than 10
        const elementStr = elementCount < 10 ? `0${elementCount}` : `${elementCount}`;
        return `${segment}-${elementStr}`;
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}
