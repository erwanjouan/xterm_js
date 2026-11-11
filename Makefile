PLATFORM      := $(shell node -e "process.stdout.write(process.platform)")
PLATFORM_CMDS := $(shell node -e "const yaml=require('js-yaml'),fs=require('fs'); const a=yaml.load(fs.readFileSync('config.yaml','utf8')).autocomplete; console.log((a.platform||[]).join(' '))")
COMMON_CMDS   := $(shell node -e "const yaml=require('js-yaml'),fs=require('fs'); const a=yaml.load(fs.readFileSync('config.yaml','utf8')).autocomplete; console.log((a.common||[]).join(' '))")
COMMANDS      := $(PLATFORM_CMDS) $(COMMON_CMDS)

.PHONY: options build run clean

## Extract man-page options for COMMANDS into options/$(PLATFORM)/*.json
options:
	@npx ts-node --transpile-only scripts/extract-options.ts $(COMMANDS)

## Full build (server + client). Run 'make options' first if options/ is missing.
build:
	npm run build

## Build then start the server
run: build
	node dist/server.js

## Remove compiled output
clean:
	rm -rf dist
