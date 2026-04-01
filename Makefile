.PHONY: install update uninstall lint test

INSTALL_DIR := $(HOME)/.copilot/extensions/anvil
AGENTS_DIR := $(HOME)/.copilot/agents

## install — Install or update Forge to ~/.copilot/extensions/anvil/
install:
	@bash install.sh

## update — Same as install (the script handles both)
update: install

## uninstall — Remove Forge from all Copilot CLI locations
uninstall:
	@if [ -d "$(INSTALL_DIR)" ]; then \
		rm -rf "$(INSTALL_DIR)"; \
		printf "\033[0;32m✔\033[0m Removed extension from $(INSTALL_DIR)\n"; \
	else \
		printf "\033[0;33m⚠\033[0m Extension not installed at $(INSTALL_DIR)\n"; \
	fi
	@for f in $(AGENTS_DIR)/anvil-*.agent.md; do \
		if [ -f "$$f" ]; then \
			rm -f "$$f"; \
			printf "\033[0;32m✔\033[0m Removed agent: $$(basename $$f)\n"; \
		fi; \
	done
	@if [ -d "$(HOME)/.copilot/extensions/.anvil-backup" ]; then \
		rm -rf "$(HOME)/.copilot/extensions/.anvil-backup"; \
		printf "\033[0;32m✔\033[0m Removed backup directory\n"; \
	fi
	@printf "  Run /clear in Copilot CLI to reload.\n"

## lint — Check extension.mjs syntax, plugin.json, and agent frontmatter
lint:
	@node --check extension/extension.mjs 2>/dev/null && \
		printf "\033[0;32m✔\033[0m extension.mjs syntax OK\n" || \
		(printf "\033[0;31m✖\033[0m extension.mjs has syntax errors\n" && exit 1)
	@node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf-8'))" 2>/dev/null && \
		printf "\033[0;32m✔\033[0m plugin.json is valid JSON\n" || \
		(printf "\033[0;31m✖\033[0m plugin.json is not valid JSON\n" && exit 1)
	@for f in .github/agents/*.agent.md; do \
		if [ -f "$$f" ]; then \
			head -1 "$$f" | grep -q "^---$$" || \
				(printf "\033[0;31m✖\033[0m $$f missing frontmatter\n" && exit 1); \
		fi; \
	done && printf "\033[0;32m✔\033[0m All agent files have frontmatter\n"

## test — Placeholder for future tests
test: lint
	@printf "\033[0;33m⚠\033[0m No tests yet. Lint passed.\n"

## help — Show available targets
help:
	@printf "Forge Makefile targets:\n\n"
	@grep -E '^## ' Makefile | sed 's/^## /  /'
	@printf "\n"
