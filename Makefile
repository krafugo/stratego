# Stratego — common tasks. Run `make` or `make help` to list them.
SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM      ?= npm
DEV_URL  := http://127.0.0.1:5190
PREV_URL := http://127.0.0.1:5191

.PHONY: help install start dev serve build test lint typecheck check ci clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "; printf "\nUsage: make <target>\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2} END {print ""}' $(MAKEFILE_LIST)

node_modules: package.json package-lock.json
	$(NPM) ci
	@touch node_modules

install: node_modules ## Install dependencies (npm ci)

start: node_modules ## Run the game locally with hot reload at http://127.0.0.1:5190
	@echo "→ $(DEV_URL)  (two seats in one browser: create with #transport=local, join with the invite link + &seat=b)"
	$(NPM) run dev

dev: start ## Alias for start

serve: build ## Serve the production build at http://127.0.0.1:5191
	@echo "→ $(PREV_URL)"
	$(NPM) run preview

build: node_modules ## Type-check and build the static site into dist/
	$(NPM) run build

test: node_modules ## Run the engine and protocol tests
	$(NPM) test

lint: node_modules ## Lint TypeScript with ESLint
	$(NPM) run lint

typecheck: node_modules ## Type-check without emitting
	$(NPM) run typecheck

check: node_modules ## Everything CI runs: typecheck, lint, tests, build
	$(NPM) run typecheck
	$(NPM) run lint
	$(NPM) test
	$(NPM) run build
	@echo
	@echo "✔ All checks passed"

ci: check ## Alias for check

clean: ## Remove build output
	rm -rf dist dev-dist
