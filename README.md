# EDI Tools (for VSCode)

<p align="center">
<img height="100px" src="https://github.com/RustyJonez/edi-tools-vscode/blob/main/img/logo.png?raw=true"/>
</p>

<p align="center">
Syntax highlighting, formatting, and reference tools for EDI X12 and EDIFACT documents in Visual Studio Code.
</p>

## Features

### Syntax Highlighting
- **X12** - Color coded by envelope, header, detail, and summary loops.
- **EDIFACT** - Basic highlighting by segment and delimiter (more coming soon)

### Hover Tooltips:
<img src="https://github.com/RustyJonez/edi-tools-vscode/blob/main/img/tooltips.gif?raw=true">

Hover over segments and elements for instant reference:
- Segment name/description
- Element information
- Code value translations (qualifier lookups)
- EDIFACT composite element structure
- Direct links to Stedi reference documentation

### Editor Action Buttons
Quick access buttons at the top of every EDI document (also available via command pallette):
- **Quick Format** - Normalize delimiters and add line breaks
<img src="https://github.com/RustyJonez/edi-tools-vscode/blob/main/img/quick_format.gif?raw=true">
- **Update IDs** - Modify sender/receiver identifiers and qualifiers
<img src="https://github.com/RustyJonez/edi-tools-vscode/blob/main/img/update_ids.gif?raw=true">

- **Lookup Transaction** - Open STEDI reference for the document transaction set/message type.

### Commands:

| Command | Keybinding | Description |
|---------|------------|-------------|
| Quick Format | `Ctrl+E Ctrl+E` | Normalize delimiters + add line breaks |
| Normalize Delimiters | `Ctrl+E Ctrl+N` | Convert to standard delimiters (*/~, X12 only) |
| Add Line Breaks | `Ctrl+E Ctrl+L` | Add line breaks after segment terminators |
| Lookup Segment at Cursor | `Ctrl+E Ctrl+S` | Open Stedi reference for current segment |
| Lookup Transaction Set | `Ctrl+E Ctrl+T` | Open Stedi reference for document type |
| Search Segment | - | Search any segment on STEDI reference |
| Search Transaction Set | - | Search any transaction set on STEDI |


### Install From Source
```bash
git clone https://github.com/RustyJonez/edi-tools-vscode.git
cd edi-x12-tools
npm install
npm run compile
```
Press `F5` to launch the Extension Development Host.

## Requirements

- Visual Studio Code 1.75.0+

## Credits

Reference documentation powered by [Stedi](https://www.stedi.com/edi).

## License

MIT