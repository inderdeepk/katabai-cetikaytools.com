# Katab (ਕਿਤਾਬ) User Help Guide

Welcome to **Katab (ਕਿਤਾਬ)**, your beautiful desktop AI assistant integrated directly into your GNOME status bar. This guide will walk you through setting up Katab, configuring your preferred AI providers, and making the most of the assistant.

---

## 1. Getting Started

Once you have installed Katab (as described in the `README.md`), it will appear as an icon in your GNOME top panel (status bar).

### Opening Katab
* Click the Katab icon in the top panel to open the assistant overlay.
* This interface allows you to chat directly with your selected AI model without needing to open a separate browser tab or terminal.

---

## 2. Configuration & Setup

Katab supports multiple AI backends, from local execution environments to cloud models. You can configure these in the GNOME Extensions preferences.

### Accessing Preferences
1. Open the **Extensions** app (`gnome-extensions-app`) on your GNOME desktop.
2. Scroll to **Katab - AI Assistant**.
3. Click the **Settings (gear)** icon next to it.

### Selecting a Provider
In the **General** tab of the settings window, you can choose your primary AI provider from the **Model Provider** dropdown:
* **Unsloth Studio (Local)**: Great for optimized local AI workloads.
* **Ollama (Local)**: A fast and lightweight local model runner.
* **OpenAI**: Connects to OpenAI's cloud API.
* **Anthropic**: Connects to Claude cloud API.

---

## 3. Provider-Specific Setup

Depending on which provider you choose, you'll need to set the corresponding keys and URLs in the preferences window. Katab stores these securely in GNOME's GSettings—never in plain-text `.env` files.

### 🦥 Unsloth Studio (Local)
1. **Base URL**: Ensure it points to your Unsloth endpoint (Default: `http://localhost:8888/v1`).
2. **API Key**: If your Unsloth Studio configuration requires an API key, enter it here.
3. **Model**: Specify the local model name you want Unsloth to utilize (e.g., `default`).

### 🦙 Ollama (Local)
1. Ensure the Ollama daemon is running on your system (`systemctl status ollama` or run `ollama serve`).
2. Setup the Ollama connection via Katab settings if non-default ports are used.
3. **Important**: You must have pulled a model via your terminal first (e.g., `ollama run llama3`).
4. To attach PNG or JPG images, pull and select a vision-capable Ollama model first (for example, `ollama pull llama3.2-vision` or `ollama pull llava`).

### ☁️ OpenAI
1. **Base URL**: Typically `https://api.openai.com/v1`.
2. **API Key**: Enter your OpenAI API key starting with `sk-`.
3. **Model**: Enter the model name (e.g., `gpt-4o`, `gpt-3.5-turbo`).

### 🤖 Anthropic
1. **Base URL**: Typically the standard Anthropic API endpoint.
2. **API Key**: Enter your Anthropic API key starting with `sk-ant-`.
3. **Model**: Enter the model name (e.g., `claude-3-5-sonnet-20240620`).

---

## 4. Using the Assistant

Once configured:
1. Click the Katab icon in the status bar to toggle the dialogue window.
2. If you change your provider in the settings, the chat will display a system message confirming the engine swap (e.g., "Switched engine to Ollama (Local).").
3. Type your message and hit Enter to send. Press Shift+Enter to insert a new line in the prompt box.

---

## 5. Optional Document Tool

Katab includes an optional document tool for attaching local files to chat. It is disabled by default, so regular chat works exactly the same if you never turn it on.

### Enabling the Document Tool
1. Open the **Settings (gear)** icon for Katab.
2. Go to the **Tools** page.
3. Turn on **Enable Document Tool**.
4. Check the capability badges:
	* **Built in**: No extra package is needed.
	* **Detected**: Katab found the required local parser.
	* **Install**: The parser is missing and you need to install it first.

### Supported Formats
* **`.txt` / `.md`**: Built in, no extra packages required.
* **`.png` / `.jpg` / `.jpeg`**: Built in, but only sent when Ollama is the active provider and the selected model supports vision.
* **`.pdf`**: Requires `pdftotext` from `poppler-utils` or your distro's `poppler` package.
* **`.docx`**: Requires `pandoc`.

### Installing Missing Tools
Common installation commands:

```bash
# Debian / Ubuntu
sudo apt install poppler-utils pandoc

# Fedora
sudo dnf install poppler-utils pandoc

# Arch
sudo pacman -S poppler pandoc
```

You can verify the tools with:

```bash
which pdftotext
which pandoc
```

### Attaching a File
You have two ways to attach a file:

1. Click the attachment button in the chat footer and choose a local file.
2. Use the `/doc` command directly.

Examples:

```text
/doc
/doc "/absolute/path/to/file.pdf"
/doc "/absolute/path/to/file.docx" summarize the main points
/doc "/absolute/path/to/screenshot.png" describe what is in this image
```

If you type `/doc` without a quoted path, Katab opens the file picker. If the picker is unavailable, use `/doc` with a quoted absolute path instead.

### Important Behavior Notes
* Katab parses supported documents locally before sending the extracted text to your selected provider.
* Image attachments are base64-encoded locally and sent only when Ollama is active and the selected Ollama model looks vision-capable.
* Saved conversations keep attachment metadata, not the full extracted text or image bytes. If you reopen an older conversation and want the full attachment context again, reattach the file.
* Only local native files are supported right now.

---

## 6. Troubleshooting & Tips

* **Extension Not Showing**: Ensure you ran `glib-compile-schemas schemas/` during installation and restarted the GNOME shell (Log out/in on Wayland, or `Alt+F2`, type `r`, and hit Enter on X11).
* **Connection Refused (Local)**: If using Unsloth or Ollama, make sure the respective server is running in the background.
* **Image Attachments Fail in Ollama**: Make sure the active Ollama model is vision-capable, such as `llama3.2-vision` or `llava`.
* **Invalid API Key**: If using OpenAI or Anthropic and responses fail, double-check your API keys in the settings panel. (Katab does not look for `.env` files for security reasons, it strictly uses the settings window).
* **Document Tool Shows Install**: Open the **Tools** page, install the missing package (`poppler-utils`/`poppler` for PDF or `pandoc` for DOCX), then use **Refresh Detection**.
* **File Picker Does Not Open**: Use `/doc "/absolute/path/to/file"` as a manual fallback.

Enjoy utilizing Katab to enhance your GNOME desktop workflow!
