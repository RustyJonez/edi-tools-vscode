# EDI X12 Tools

Syntax highlighting, formatting, and reference tools for EDI X12 and EDIFACT documents in Visual Studio Code.

<!-- Screenshots placeholder - add actual screenshots here -->

## Features

### Syntax Highlighting
- **X12** - Segments, elements, and delimiters (.edi, .x12, .asv, .txt)
- **EDIFACT** - Full syntax support (.edifact, UNA/UNB detection)
- Color-coded envelope, header, detail, and summary segments

### Hover Information
Hover over segments and elements for instant reference:
- Segment names and descriptions
- Element definitions with data types and lengths
- Code value translations (qualifier lookups)
- EDIFACT composite element structure
- Direct links to Stedi reference documentation

### Editor Action Buttons
Quick access buttons at the top of every EDI document:
- **Quick Format** - Normalize delimiters and add line breaks
- **Lookup Transaction** - Open reference for the document's transaction set
- **Update IDs** - Modify sender/receiver identifiers

### Formatting Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Quick Format | `Ctrl+E Ctrl+E` | Normalize delimiters + add line breaks |
| Normalize Delimiters | `Ctrl+E Ctrl+N` | Convert to standard delimiters (*/~) |
| Add Line Breaks | `Ctrl+E Ctrl+L` | Add line breaks after segment terminators |

### Reference Lookup

| Command | Keybinding | Description |
|---------|------------|-------------|
| Lookup Segment at Cursor | `Ctrl+E Ctrl+S` | Open Stedi reference for current segment |
| Lookup Transaction Set | `Ctrl+E Ctrl+T` | Open Stedi reference for document type |
| Search Segment | - | Search any segment code |
| Search Transaction Set | - | Search any transaction set |

### Update Sender/Receiver IDs
Modify interchange identifiers directly in the editor:
- **X12**: Updates ISA-05/06/07/08 (qualifiers and IDs) and GS-02/03
- **EDIFACT**: Updates UNB sender/receiver with optional qualifiers

## Installation

### From VSIX
1. Download the `.vsix` file
2. In VSCode: Extensions > ... > Install from VSIX

### From Source
```bash
git clone https://github.com/yourusername/edi-x12-tools.git
cd edi-x12-tools
npm install
npm run compile
```
Press `F5` to launch the Extension Development Host.

## Supported File Types

| Extension | Format |
|-----------|--------|
| `.edi`, `.x12`, `.asv` | X12 EDI |
| `.txt` (starting with ISA) | X12 EDI |
| `.edifact` | EDIFACT |
| Files starting with UNA/UNB | EDIFACT |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ediX12Tools.hover.enabled` | `true` | Enable hover tooltips |
| `ediX12Tools.hover.showElements` | `true` | Show element list in segment hovers |

## Requirements

- Visual Studio Code 1.75.0+

## Credits

Reference documentation powered by [Stedi](https://www.stedi.com/edi).

## License

MIT