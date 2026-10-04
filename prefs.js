import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { buildToolsPage } from './src/ui/prefs/tools/index.js';
import { createPrefsContext } from './src/ui/prefs/widgets.js';
import { buildGeneralPage } from './src/ui/prefs/generalPage.js';
import { buildOllamaPage } from './src/ui/prefs/ollamaPage.js';
import { buildDeepSeekPage } from './src/ui/prefs/deepseekPage.js';
import { buildSimpleProviderPages } from './src/ui/prefs/providerPages.js';

export default class KatabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window.add_css_class('katab-prefs-window');
        window.default_width = 740;
        window.default_height = 660;

        const settings = this.getSettings('org.gnome.shell.extensions.katabai');
        const extensionPath = this.path;
        const iconDirectory = `${extensionPath}/icons`;

        const display = window.get_display();
        if (display) {
            const iconTheme = Gtk.IconTheme.get_for_display(display);
            try {
                const searchPaths = iconTheme.get_search_path();
                if (!searchPaths.includes(iconDirectory)) {
                    iconTheme.add_search_path(iconDirectory);
                }
            } catch (_e) {
                iconTheme.add_search_path(iconDirectory);
            }

            if (!this._prefsCssLoaded) {
                const cssProvider = new Gtk.CssProvider();
                cssProvider.load_from_path(`${extensionPath}/prefs.css`);
                Gtk.StyleContext.add_provider_for_display(
                    display,
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
                this._prefsCssLoaded = true;
            }

            const applyPrefsTheme = () => {
                try {
                    const styleManager = Adw.StyleManager.get_default();
                    const isDark = styleManager.get_dark();
                    window.remove_css_class('katab-prefs-theme-dark');
                    window.remove_css_class('katab-prefs-theme-light');
                    window.add_css_class(
                        isDark ? 'katab-prefs-theme-dark' : 'katab-prefs-theme-light',
                    );
                } catch (_e) {
                    window.add_css_class('katab-prefs-theme-dark');
                }
            };
            applyPrefsTheme();
            try {
                const styleManager = Adw.StyleManager.get_default();
                const themeHandlerId = styleManager.connect('notify::dark', applyPrefsTheme);
                window.connect('destroy', () => styleManager.disconnect(themeHandlerId));
            } catch (_e) {
                /* StyleManager unavailable */
            }
        }

        // Shared widget factories (page/group/row builders, badges, shortcut
        // capture, tool subpage scaffolding) live in src/ui/prefs/widgets.js.
        // Every page builder receives ctx directly; ctx.watch() is preferred
        // for new GSettings handlers so window-destroy cleanup is automatic.
        const ctx = createPrefsContext({ settings, window, extensionPath });
        window.connect('destroy', () => ctx.dispose());

        buildGeneralPage(ctx);

        buildOllamaPage(ctx);

        buildDeepSeekPage(ctx);

        buildSimpleProviderPages(ctx);

        // --- Tools Settings ---
        buildToolsPage(ctx);
    }
}
