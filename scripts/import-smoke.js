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
]);

const EXCLUDED_PREFIXES = [
    // GTK4/libadwaita modules — only importable in the preferences process.
    'src/ui/prefs/',
];

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
    if (
        EXCLUDED_FILES.has(relPath) ||
        EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
    ) {
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
print(`[OK] Import smoke: ${imported} src modules imported, ${skipped} excluded.`);
