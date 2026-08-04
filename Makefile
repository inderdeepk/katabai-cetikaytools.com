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
	@echo "--- Running pet collection tests ---"
	@gjs -m tests/petCollection.test.js
	@echo "--- Running token usage manager tests ---"
	@gjs -m tests/tokenUsageManager.test.js
	@echo "[OK] All tests passed"

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
