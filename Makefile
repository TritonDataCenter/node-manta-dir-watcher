#
# Copyright 2016 Joyent, Inc.
#

JS_FILES := $(shell find lib -name "*.js") bin/*
ESLINT = ./node_modules/.bin/eslint


all $(ESLINT):
	npm install

.PHONY: distclean
distclean:
	rm -rf node_modules

.PHONY: check
check:: versioncheck check-eslint
	@echo "Check ok."

.PHONY: check-eslint
check-eslint: | $(ESLINT)
	$(ESLINT) ./

.PHONY: versioncheck
versioncheck:
	[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -1 | awk '{print $$2}'` ]]

.PHONY: cutarelease
cutarelease: versioncheck
	[[ `git status | tail -n1` == "nothing to commit, working directory clean" ]]
	./tools/cutarelease.py -p manta-dir-watcher -f package.json
