import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KatabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        const settings = this.getSettings('org.gnome.shell.extensions.katabai');

        // General Provider Selection
        const generalGroup = new Adw.PreferencesGroup({
            title: 'AI Provider Settings',
        });
        page.add(generalGroup);

        const providerRow = new Adw.ComboRow({
            title: 'Model Provider',
            subtitle: 'Choose which AI provider Katabai uses',
        });

        const providerList = new Gtk.StringList();
        providerList.append('Unsloth Studio (Local)');
        providerList.append('Ollama (Local)');
        providerList.append('OpenAI');
        providerList.append('Anthropic');
        providerRow.model = providerList;

        const providerMap = ['unsloth', 'ollama', 'openai', 'anthropic'];
        const currentProvider = settings.get_string('provider');
        providerRow.selected = Math.max(0, providerMap.indexOf(currentProvider));

        providerRow.connect('notify::selected', () => {
            settings.set_string('provider', providerMap[providerRow.selected]);
        });
        generalGroup.add(providerRow);

        // Helper to create string input rows binding to GSettings
        const createStringRow = (title, key, group, isPassword = false) => {
            const row = new Adw.EntryRow({
                title: title,
            });
            if (isPassword) {
                row.input_purpose = Gtk.InputPurpose.PASSWORD;
            }

            // Initial value
            row.text = settings.get_string(key);

            // Sync setting to key
            row.connect('changed', () => {
                settings.set_string(key, row.text);
            });

            group.add(row);
            return row;
        };

        // --- Unsloth Settings ---
        const unslothGroup = new Adw.PreferencesGroup({
            title: 'Unsloth Studio Settings',
        });
        createStringRow('Base URL', 'unsloth-url', unslothGroup);
        createStringRow('API Key', 'unsloth-api-key', unslothGroup, true);
        createStringRow('Model', 'unsloth-model', unslothGroup);
        page.add(unslothGroup);

        // --- Ollama Settings ---
        const ollamaGroup = new Adw.PreferencesGroup({
            title: 'Ollama Settings',
        });
        createStringRow('Base URL', 'ollama-url', ollamaGroup);
        createStringRow('Model', 'ollama-model', ollamaGroup);
        page.add(ollamaGroup);

        // --- OpenAI Settings ---
        const openaiGroup = new Adw.PreferencesGroup({
            title: 'OpenAI Settings',
        });
        createStringRow('Base URL', 'openai-url', openaiGroup);
        createStringRow('API Key', 'openai-api-key', openaiGroup, true);
        createStringRow('Model', 'openai-model', openaiGroup);
        page.add(openaiGroup);

        // --- Anthropic Settings ---
        const anthropicGroup = new Adw.PreferencesGroup({
            title: 'Anthropic Settings',
        });
        createStringRow('Base URL', 'anthropic-url', anthropicGroup);
        createStringRow('API Key', 'anthropic-api-key', anthropicGroup, true);
        createStringRow('Model', 'anthropic-model', anthropicGroup);
        page.add(anthropicGroup);
    }
}
