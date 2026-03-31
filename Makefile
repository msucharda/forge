.PHONY: install update uninstall lint lint-plugins test

INSTALL_DIR := $(HOME)/.copilot/extensions/anvil
AGENTS_DIR := $(HOME)/.copilot/agents
SKILLS_DIR := $(HOME)/.copilot/skills

## install — Install or update Anvil to ~/.copilot/extensions/anvil/
install:
	@bash install.sh

## update — Same as install (the script handles both)
update: install

## uninstall — Remove Anvil from all Copilot CLI locations
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
	@for d in $(SKILLS_DIR)/anvil-*; do \
		if [ -d "$$d" ]; then \
			rm -rf "$$d"; \
			printf "\033[0;32m✔\033[0m Removed skill: $$(basename $$d)\n"; \
		fi; \
	done
	@if [ -d "$(HOME)/.copilot/extensions/.anvil-backup" ]; then \
		rm -rf "$(HOME)/.copilot/extensions/.anvil-backup"; \
		printf "\033[0;32m✔\033[0m Removed backup directory\n"; \
	fi
	@printf "  Run /clear in Copilot CLI to reload.\n"

## lint — Check extension.mjs syntax, plugin.json validity, and all plugin files
lint: lint-plugins
	@node --check extension/extension.mjs 2>/dev/null && \
		printf "\033[0;32m✔\033[0m extension.mjs syntax OK\n" || \
		(printf "\033[0;31m✖\033[0m extension.mjs has syntax errors\n" && exit 1)
	@node -e "JSON.parse(require('fs').readFileSync('plugin.json','utf-8'))" 2>/dev/null && \
		printf "\033[0;32m✔\033[0m plugin.json is valid JSON\n" || \
		(printf "\033[0;31m✖\033[0m plugin.json is not valid JSON\n" && exit 1)
	@node -e "JSON.parse(require('fs').readFileSync('.github/plugin/marketplace.json','utf-8'))" 2>/dev/null && \
		printf "\033[0;32m✔\033[0m marketplace.json is valid JSON\n" || \
		(printf "\033[0;31m✖\033[0m marketplace.json is not valid JSON\n" && exit 1)

## lint-plugins — Check all plugin files for valid JSON and frontmatter
lint-plugins:
	@for pj in plugins/*/plugin.json; do \
		if [ -f "$$pj" ]; then \
			node -e "JSON.parse(require('fs').readFileSync('$$pj','utf-8'))" 2>/dev/null && \
				printf "\033[0;32m✔\033[0m $$pj is valid JSON\n" || \
				(printf "\033[0;31m✖\033[0m $$pj is not valid JSON\n" && exit 1); \
		fi; \
	done
	@for f in plugins/*/skills/*/SKILL.md plugins/*/commands/*.md plugins/*/agents/*.agent.md; do \
		if [ -f "$$f" ]; then \
			head -1 "$$f" | grep -q "^---$$" || \
				(printf "\033[0;31m✖\033[0m $$f missing frontmatter\n" && exit 1); \
		fi; \
	done && printf "\033[0;32m✔\033[0m All plugin markdown files have frontmatter\n"
	@for hj in plugins/*/hooks.json; do \
		if [ -f "$$hj" ]; then \
			node -e "JSON.parse(require('fs').readFileSync('$$hj','utf-8'))" 2>/dev/null && \
				printf "\033[0;32m✔\033[0m $$hj is valid JSON\n" || \
				(printf "\033[0;31m✖\033[0m $$hj is not valid JSON\n" && exit 1); \
		fi; \
	done

## test — Placeholder for future tests
test: lint
	@printf "\033[0;33m⚠\033[0m No tests yet. Lint passed.\n"

## help — Show available targets
help:
	@printf "Anvil Makefile targets:\n\n"
	@grep -E '^## ' Makefile | sed 's/^## /  /'
	@printf "\n"
