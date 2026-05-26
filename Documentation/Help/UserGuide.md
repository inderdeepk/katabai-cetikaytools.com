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
3. Type your message and hit Enter. Katab handles the background communication and streams the response directly to your desktop.

---

## 5. Troubleshooting & Tips

* **Extension Not Showing**: Ensure you ran `glib-compile-schemas schemas/` during installation and restarted the GNOME shell (Log out/in on Wayland, or `Alt+F2`, type `r`, and hit Enter on X11).
* **Connection Refused (Local)**: If using Unsloth or Ollama, make sure the respective server is running in the background.
* **Invalid API Key**: If using OpenAI or Anthropic and responses fail, double-check your API keys in the settings panel. (Katab does not look for `.env` files for security reasons, it strictly uses the settings window).

Enjoy utilizing Katab to enhance your GNOME desktop workflow!
