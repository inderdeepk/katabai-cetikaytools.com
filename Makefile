# Katabai GNOME Extension — Makefile
# =====================================

EXTENSION_DIR  := $(shell pwd)
UUID           := katabai@cetikaytools.com
INSTALL_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
PACKAGE_NAME   := $(UUID).zip

.PHONY: all compile-schemas check lint format format-check test test-verbose test-rag-server sync-rag-server package install reload logs clean help

# Every JS file that must parse as an ES module (checked via node --check).
JS_CHECK_FILES := extension.js prefs.js $(shell find src tests scripts \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null)

# Test suites are discovered, not listed, so test/test-verbose can never drift.
TEST_FILES := $(wildcard tests/*.test.js)

## all            : Compile schemas and run checks
all: compile-schemas check

## compile-schemas: Recompile GSettings schema
compile-schemas:
	glib-compile-schemas schemas/
	@echo "[OK] GSettings schema compiled"

## check          : Verify every JS file parses as an ES module (node --check)
check:
	@echo "--- ES module syntax checks (node --input-type=module --check) ---"
	@if command -v node >/dev/null 2>&1; then \
		count=0; fail=0; \
		for f in $(JS_CHECK_FILES); do \
			count=$$((count + 1)); \
			if ! node --input-type=module --check < "$$f"; then \
				echo "[FAIL] $$f"; \
				fail=1; \
			fi; \
		done; \
		if [ $$fail -ne 0 ]; then echo "[FAIL] Syntax errors found"; exit 1; fi; \
		echo "[OK] $$count files parse as ES modules"; \
	else \
		echo "[WARN] node not found - skipping JS syntax checks (install Node.js to enable)"; \
	fi
	@echo "--- CSS delimiter balance ---"
	@if command -v node >/dev/null 2>&1; then \
		node scripts/check-css.mjs; \
	else \
		echo "[WARN] node not found - skipping CSS balance check"; \
	fi
	@echo "--- GJS import smoke (src modules) ---"
	@if command -v gjs >/dev/null 2>&1; then \
		gjs -m scripts/import-smoke.js; \
	else \
		echo "[WARN] gjs not found - skipping import smoke"; \
	fi

## lint           : Run ESLint (requires: npm install)
lint:
	npm run lint

## format         : Apply Prettier formatting (requires: npm install)
format:
	npm run format

## format-check   : Verify Prettier formatting without writing (requires: npm install)
format-check:
	npm run format:check

## test           : Run all unit tests (discovered from tests/*.test.js)
test:
	@echo "=== Unit tests: $(words $(TEST_FILES)) suites ==="
	@for f in $(TEST_FILES); do \
		echo "--- Running $$f ---"; \
		gjs -m $$f || exit 1; \
	done
	@echo "[OK] All tests passed"

## test-verbose   : Run all unit tests with per-test output (never aborts early)
test-verbose:
	@echo "=== Full test suite (verbose): $(words $(TEST_FILES)) suites ==="
	@for f in $(TEST_FILES); do \
		echo "--- Running $$f ---"; \
		gjs -m $$f || true; \
	done
	@echo "=== Done ==="

## test-rag-server : Run RAG server unit tests (stdlib unittest via the service venv)
test-rag-server:
	@if [ -x $(HOME)/.local/share/katabai/rag-service/.venv/bin/python ]; then \
		$(HOME)/.local/share/katabai/rag-service/.venv/bin/python -m unittest discover -s rag-service/tests -p 'test_*.py'; \
	else \
		echo "[SKIP] RAG service venv not found"; \
	fi

## sync-rag-server : Copy the in-repo RAG server into ~/.local/share/katabai/rag-service
sync-rag-server:
	@cp rag-service/server.py $(HOME)/.local/share/katabai/rag-service/server.py
	@echo "[OK] RAG server synced — restart with: systemctl --user restart katabai-rag"

## package        : Create a distributable .zip for extensions.gnome.org
package:
	@rm -f $(PACKAGE_NAME)
	zip -r $(PACKAGE_NAME) \
		extension.js prefs.js metadata.json README.md \
		stylesheet.css prefs.css \
		schemas/ icons/ sprites/ src/ Documentation/ rag-service/ \
		-x "*.git*" "*.swp" ".vscode/*" "schemas/*~" "*.zip" "*__pycache__*" "*.pyc"
	@echo "[OK] Package created: $(PACKAGE_NAME)"

## install        : Copy extension to local GNOME extensions directory
install:
	@mkdir -p $(INSTALL_DIR)
	rsync -av --exclude='.git' --exclude='.vscode' --exclude='*.zip' --exclude='*.swp' ./ $(INSTALL_DIR)/
	@echo "[OK] Installed to $(INSTALL_DIR)"

## reload         : Disable + re-enable the extension in the running GNOME Shell
reload:
	@gnome-extensions disable $(UUID) 2>/dev/null || true
	@gnome-extensions enable $(UUID)
	@echo "[OK] Extension reloaded - follow logs with: make logs"

## logs           : Follow GNOME Shell journal lines that mention katab
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i katab

## clean          : Remove build artifacts
clean:
	rm -f $(PACKAGE_NAME)
	rm -rf .pytest_cache
	@find rag-service -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
	@echo "[OK] Cleaned"

## help           : Show this help message
help:
	@grep '^##' Makefile | cut -c 4-
