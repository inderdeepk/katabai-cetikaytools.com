# Katab (ਕਿਤਾਬ) - AI Assistant

Katab (ਕਿਤਾਬ) is a beautiful GNOME desktop AI assistant, offering quick access to local Ollama endpoints and OpenAI tools right from your status bar.

## Goals

The vision for Katab is to provide a seamless, integrated AI assistant directly into the GNOME desktop environment, enabling quick local and remote AI access without disrupting your workflow.

## Installation

### Prerequisites
- GNOME Shell version 46.
- Optional document parsing:
   - Plain text and Markdown work without extra packages.
   - PDFs require `pdftotext` from `poppler-utils` or the distro-equivalent `poppler` package.
   - DOCX files require `pandoc`.

### Manual Installation
1. Clone or download the repository into your GNOME shell extensions directory:
   ```bash
   git clone https://github.com/inderdeepk/katabai-cetikaytools.com.git ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```
2. Navigate to the extension directory:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```
3. Compile the settings schema:
   ```bash
   glib-compile-schemas schemas/
   ```
4. Restart GNOME Shell (or log out and log back in on Wayland).
5. Enable the extension using the Extensions application (`gnome-extensions-app`) or via the command line:
   ```bash
   gnome-extensions enable katabai@cetikaytools.com
   ```

## Configuration & Security

Katab is designed with security in mind. API keys are safely managed using GNOME's GSettings and are never hardcoded into the source code or loaded from plain text `.env` files.

To configure your API keys:
1. Open the GNOME Extensions application.
2. Click on the settings (gear) icon next to the "Katab - AI Assistant" extension.
3. Enter your API keys for Unsloth, OpenAI, or Anthropic in the Preferences window.
4. The extension will securely save these keys using GSettings.

## Optional Document Tool

Katab now includes an optional document tool that stays disabled by default. Basic chat does not depend on it.

To enable it:
1. Open the Katab preferences window.
2. Go to the `Tools` page.
3. Turn on `Enable Document Tool`.
4. Check the capability badges:
   - `Built in` means Katab can already read that format.
   - `Detected` means the required local parser was found on your system.
   - `Install` means the parser is missing and the settings page will tell you which package to install.

Common install commands:

```bash
# Debian / Ubuntu
sudo apt install poppler-utils pandoc

# Fedora
sudo dnf install poppler-utils pandoc

# Arch
sudo pacman -S poppler pandoc
```

Verify detection with:

```bash
which pdftotext
which pandoc
```

Once enabled, you can either click the document button in chat or use `/doc` directly:

```text
/doc
/doc "/absolute/path/to/file.pdf"
/doc "/absolute/path/to/file.docx" summarize the key points
```

Typing `/doc` with no quoted path opens the file picker. Supported formats are `.txt`, `.md`, `.pdf`, and `.docx`.

## Chat Formatting

Assistant responses now render a chat-friendly markdown subset instead of showing raw formatting markers. Supported formatting includes headings, bold text, italics, bullet and numbered lists, blockquotes, inline code, and fenced code blocks.

Links are extracted from assistant responses and shown as clickable actions below the message bubble so they can be opened with your default browser. Markdown tables now render as structured chat tables; images and full CommonMark edge cases are still treated as plain text.

## Contribution Guidelines

* **NEVER commit any API keys, credentials, or secrets to the repository.**
* Ensure that the `schemas/gschemas.compiled` file and any IDE configurations are kept out of version control (they are ignored via `.gitignore`).
* When updating documentation, always use mock placeholders for any API key examples (e.g., `sk-xxxxxxxxxxxx`).

## License

*(Add your license information here)*
