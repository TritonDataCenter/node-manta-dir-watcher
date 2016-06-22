#
# Copyright 2016 Trent Mick
# Copyright 2016 Joyent, Inc.
#

JSSTYLE_FILES := $(shell find lib -name "*.js")


all:
	npm install

.PHONY: distclean
distclean:
	rm -rf node_modules

.PHONY: check
check:: versioncheck
	@echo "Check ok."


.PHONY: versioncheck
versioncheck:
	[[ `cat package.json | json version` == `grep '^## ' CHANGES.md | head -1 | awk '{print $$2}'` ]]

.PHONY: cutarelease
cutarelease: versioncheck
	[[ `git status | tail -n1` == "nothing to commit, working directory clean" ]]
	./tools/cutarelease.py -p manta-dir-watcher -f package.json
