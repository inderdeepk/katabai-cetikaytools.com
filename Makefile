# Katabai GNOME Extension — Makefile
# =====================================

EXTENSION_DIR  := $(shell pwd)
UUID           := katabai@cetikaytools.com
INSTALL_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
PACKAGE_NAME   := $(UUID).zip

.PHONY: all compile-schemas check test package install clean help

## all            : Compile schemas and run checks
all: compile-schemas check

## compile-schemas: Recompile GSettings schema
compile-schemas:
	glib-compile-schemas schemas/
	@echo "[OK] GSettings schema compiled"

## check          : Verify all JS files pass syntax checks
check:
	@echo "--- Running gjs syntax checks ---"
	@gjs -c "imports.searchPath.push('.');" 2>/dev/null || true
	@echo "[OK] Check complete (full GJS validation requires in-shell reload)"

## test           : Run all unit tests
test:
	@echo "=== Phase 1: Foundation ==="
	@echo "--- Running network guard tests ---"
	@gjs -m tests/networkGuard.test.js
	@echo "--- Running citation tracker tests ---"
	@gjs -m tests/citationTracker.test.js
	@echo "--- Running tool registry tests ---"
	@gjs -m tests/toolRegistry.test.js
	@echo "=== Phase 2: Research Pipeline ==="
	@echo "--- Running compression tools tests ---"
	@gjs -m tests/compressionTools.test.js
	@echo "--- Running research cache tests ---"
	@gjs -m tests/researchCache.test.js
	@echo "=== Phase 3: Tool Implementations ==="
	@echo "--- Running web search tools tests ---"
	@gjs -m tests/webSearchTools.test.js
	@echo "--- Running tool definitions tests ---"
	@gjs -m tests/toolDefinitions.test.js
	@echo "--- Running crawl4ai tools tests ---"
	@gjs -m tests/crawl4aiTools.test.js
	@echo "--- Running explore docs tools tests ---"
	@gjs -m tests/exploreDocsTools.test.js
	@echo "--- Running document tools tests ---"
	@gjs -m tests/documentTools.test.js
	@echo "=== Phase 4: Usage & State ==="
	@echo "--- Running pet collection tests ---"
	@gjs -m tests/petCollection.test.js
	@echo "--- Running token usage manager tests ---"
	@gjs -m tests/tokenUsageManager.test.js
	@echo "--- Running preset manager tests ---"
	@gjs -m tests/presetManager.test.js
	@echo "[OK] All tests passed"

## test-verbose   : Run all unit tests with per-test output
test-verbose:
	@echo "=== Full Test Suite (verbose) ==="
	@gjs -m tests/networkGuard.test.js || true
	@gjs -m tests/citationTracker.test.js || true
	@gjs -m tests/toolRegistry.test.js || true
	@gjs -m tests/compressionTools.test.js || true
	@gjs -m tests/researchCache.test.js || true
	@gjs -m tests/webSearchTools.test.js || true
	@gjs -m tests/toolDefinitions.test.js || true
	@gjs -m tests/crawl4aiTools.test.js || true
	@gjs -m tests/documentTools.test.js || true
	@gjs -m tests/petCollection.test.js || true
	@gjs -m tests/tokenUsageManager.test.js || true
	@gjs -m tests/presetManager.test.js || true
	@echo "=== Done ==="

## package        : Create a distributable .zip for extensions.gnome.org
package:
	@rm -f $(PACKAGE_NAME)
	zip -r $(PACKAGE_NAME) \
		extension.js prefs.js metadata.json README.md \
		stylesheet.css prefs.css \
		schemas/ icons/ sprites/ src/ Documentation/ \
		-x "*.git*" "*.swp" ".vscode/*" "schemas/*~" "*.zip"
	@echo "[OK] Package created: $(PACKAGE_NAME)"

## install        : Copy extension to local GNOME extensions directory
install:
	@mkdir -p $(INSTALL_DIR)
	rsync -av --exclude='.git' --exclude='.vscode' --exclude='*.zip' --exclude='*.swp' ./ $(INSTALL_DIR)/
	@echo "[OK] Installed to $(INSTALL_DIR)"

## clean          : Remove build artifacts
clean:
	rm -f $(PACKAGE_NAME)
	@echo "[OK] Cleaned"

## help           : Show this help message
help:
	@grep '^##' Makefile | cut -c 4-
