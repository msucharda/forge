.PHONY: install update uninstall lint test

INSTALL_DIR := $(HOME)/.copilot/extensions/anvil

## install — Install or update Anvil to ~/.copilot/extensions/anvil/
install:
	@bash install.sh

## update — Same as install (the script handles both)
update: install

## uninstall — Remove Anvil from ~/.copilot/extensions/
uninstall:
	@if [ -d "$(INSTALL_DIR)" ]; then \
		rm -rf "$(INSTALL_DIR)"; \
		printf "\033[0;32m✔\033[0m Anvil uninstalled from $(INSTALL_DIR)\n"; \
		printf "  Run /clear in Copilot CLI to reload extensions.\n"; \
	else \
		printf "\033[0;33m⚠\033[0m Anvil is not installed at $(INSTALL_DIR)\n"; \
	fi
	@if [ -d "$(HOME)/.copilot/extensions/.anvil-backup" ]; then \
		rm -rf "$(HOME)/.copilot/extensions/.anvil-backup"; \
		printf "\033[0;32m✔\033[0m Removed backup directory\n"; \
	fi

## lint — Check extension.mjs syntax
lint:
	@node --check extension/extension.mjs 2>/dev/null && \
		printf "\033[0;32m✔\033[0m extension.mjs syntax OK\n" || \
		(printf "\033[0;31m✖\033[0m extension.mjs has syntax errors\n" && exit 1)

## test — Placeholder for future tests
test: lint
	@printf "\033[0;33m⚠\033[0m No tests yet. Lint passed.\n"

## help — Show available targets
help:
	@printf "Anvil Makefile targets:\n\n"
	@grep -E '^## ' Makefile | sed 's/^## /  /'
	@printf "\n"
