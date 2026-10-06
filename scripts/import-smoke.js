// GJS import smoke test — loads every src/ module that does not depend on
// shell-only (St/Clutter) or GTK/libadwaita typelibs.
//
// This catches module-resolution errors that only GJS surfaces (e.g.
// "ambiguous indirect export" when a module re-exports a name it does not
// actually have) and which `node --check` cannot see.
//
// Run from the repository root:  gjs -m scripts/import-smoke.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

const EXCLUDED_FILES = new Set([
    // Uses St/Clutter — only importable inside the GNOME Shell process.
    'src/pets/petSpriteActor.js',
    'src/ui/welcomePanel.js',
    'src/ui/usagePanel.js',
    'src/ui/historyView.js',
    'src/ui/sessionInfoPopup.js',
    'src/ui/toolsPopup.js',
    'src/ui/recentChatsPopup.js',
    'src/ui/headerBar.js',
    'src/ui/pickers.js',
    'src/ui/messageBubble.js',
    'src/ui/assistantRender.js',
]);

// GTK4/libadwaita are imported by the preferences-side modules
// (src/ui/prefs/).  They are present on GNOME desktops; when unavailable the
// prefs modules are skipped rather than failing the smoke test.
let gtkAvailable = false;
try {
    await import('gi://Gtk?version=4.0');
    await import('gi://Adw');
    gtkAvailable = true;
} catch (_e) {
    gtkAvailable = false;
}

function listJsFiles(dir) {
    const files = [];
    const enumerator = Gio.File.new_for_path(dir).enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE,
        null,
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const path = `${dir}/${name}`;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            files.push(...listJsFiles(path));
        } else if (name.endsWith('.js')) {
            files.push(path);
        }
    }
    return files;
}

const cwd = GLib.get_current_dir();
if (!GLib.file_test(`${cwd}/src`, GLib.FileTest.IS_DIR)) {
    printerr('[FAIL] Run this script from the repository root (src/ not found).');
    System.exit(1);
}

const modules = listJsFiles(`${cwd}/src`)
    .map((path) => path.slice(cwd.length + 1))
    .sort();

const failures = [];
let imported = 0;
let skipped = 0;

for (const relPath of modules) {
    if (EXCLUDED_FILES.has(relPath)) {
        skipped++;
        continue;
    }
    if (relPath.startsWith('src/ui/prefs/') && !gtkAvailable) {
        skipped++;
        continue;
    }
    try {
        await import(GLib.filename_to_uri(`${cwd}/${relPath}`, null));
        imported++;
    } catch (error) {
        failures.push(`${relPath}: ${error.message}`);
    }
}

if (failures.length > 0) {
    printerr(`[FAIL] ${failures.length} module(s) failed to import:`);
    for (const failure of failures) printerr(`  ${failure}`);
    System.exit(1);
}
const gtkNote = gtkAvailable ? '' : ' — GTK4/libadwaita unavailable, prefs modules skipped';
print(`[OK] Import smoke: ${imported} src modules imported, ${skipped} excluded${gtkNote}.`);
