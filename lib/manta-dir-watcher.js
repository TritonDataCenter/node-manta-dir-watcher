/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var bunyan = require('bunyan');
var crypto = require('crypto');
var fs = require('fs');
var manta = require('manta');
var mkdirp = require('mkdirp');
var mod_path = require('path');
var Readable = require('stream').Readable;
var rimraf = require('rimraf');
var util = require('util');
var vasync = require('vasync');
var vstream = require('vstream');


// ---- globals/consts

var format = util.format;

var FILTER_TYPES = [
    'object',
    'directory'
];


// ---- support stuff

function regexpEscape(s) {
    return s.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}

function regexpFromGlob(s) {
    return new RegExp(
        '^'
        + regexpEscape(s).replace(/\?/g, '.').replace(/\*/g, '.*')
        + '$');
}

function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}

/**
 * Calculate and return the diff between two Manta dirents.
 */
function diffDirents(a, b) {
    var isDiff = false;
    var diff = {};
    ['type', 'etag'].forEach(function (attr) {
        if (a[attr] !== b[attr]) {
            diff[attr] = [a[attr], b[attr]];
            isDiff = true;
        }
    });
    return (isDiff ? diff : null);
}


// ---- MantaDirWatcher class

/*
 * Create for a new Manta dir watcher (a readable stream).
 * The polling process is started in `nextTick`.
 *
 * If no `clientOpts` are passed in, then the usual `MANTA_*` envvars are used:
 *
 *      var watcher = new MantaDirWatcher({dir: '~~/stor/tmp'});
 *      watcher.on('data', function (evt) {
 *          console.log(JSON.stringify(evt));
 *      });
 *
 * Else, explicit Manta client options can be passed in:
 *
 *      var watcher = new MantaDirWatcher({
 *          clientOpts: {
 *              url: 'https://us-east.manta.joyent.com',
 *              user: 'trent.mick',
 *              keyId: '31:96:29:14:6a:be:45:f6:df:73:4f:3f:32:45:45:45'
 *          },
 *          dir: '~~/stor/tmp'
 *      });
 *
 * Or an already created [node-manta](https://github.com/joyent/node-manta)
 * client:
 *
 *      var client = manta.createClient(...);
 *      var watcher = new MantaDirWatcher({
 *          client: client,
 *          dir: '~~/stor/tmp'
 *      });
 *
 *
 * @param {String} opts.dir: Required. Manta dir path to watch.
 * @param {Number} opts.interval: Optional. Polling interval (in seconds).
 *      Default is 60s.
 * @param {String|RegExp} opts.filter.name: Optional. A glob pattern (if a
 *      string) or a regex to match against entry names to which to limit
 *      watching.
 * @param {String} opts.filter.type: Optional. "object" or "directory" to limit
 *      watching to entries of this type.
 * @param {String} opts.syncDir: Optional. A local directory to which to
 *      sync the watched objects. This implies `filter.type="object"` (i.e.
 *      sync'ing of directories is not supported.
 * @param {Boolean} opts.syncDelete: Optional. Allow delete of local files
 *      when syncing to `syncDir`.
 * @param {Boolean} opts.disableSyncDeleteGuard: Optional. Disable the guard
 *      that attempts to bail when it looks like the given `syncDir` was
 *      an accident. See "sync-delete-guard" in code below for details.
 * @param {Boolean} opts.dryRun: Optional. Do a dry-run, don't actually
 *      sync files.
 * @param {Object} opts.log: Optional. Bunyan logger.
 */
function MantaDirWatcher(opts) {
    var self = this;
    assert.string(opts.dir, 'opts.dir');
    assert.optionalNumber(opts.interval, 'opts.interval');
    this.intervalMs = (opts.interval !== undefined ? opts.interval : 60) * 1000;
    assert.ok(this.intervalMs > 0,
        'opts.interval is not positive: ' + opts.interval);
    assert.optionalObject(opts.log, 'opts.log');
    var filter = opts.filter || {};
    if (filter.name) {
        if (typeof(filter.name) === 'string') {
            // glob -> regex (limited to '*' and '?')
            filter.name = regexpFromGlob(filter.name);
        }
        assert.regexp(filter.name, 'opts.filter.name');
    }
    assert.optionalString(filter.type, 'opts.filter.type');
    if (filter.type) {
        assert.ok(FILTER_TYPES.indexOf(filter.type) !== -1,
            'invalid opts.filter.type: ' + filter.type);
    }
    assert.optionalString(opts.syncDir, 'opts.syncDir');
    assert.optionalBool(opts.syncDelete, 'opts.syncDelete');
    assert.optionalBool(opts.disableSyncDeleteGuard,
        'opts.disableSyncDeleteGuard');
    assert.optionalBool(opts.dryRun, 'opts.dryRun');

    // TODO other stream options? highWaterMark?
    Readable.call(this, {objectMode: true});
    vstream.wrapStream(this, {name: 'MantaDirWatcher'});

    this.dir = opts.dir;
    this.log = (opts.log
        ? opts.log.child({dir: this.dir}, true)
        : bunyan.createLogger({name: 'manta-dir-watcher', dir: this.dir}));
    this.filter = filter;
    if (opts.syncDir) {
        this.syncDir = mod_path.resolve(opts.syncDir);
    } else {
        this.syncDir = null;
    }
    this.syncDelete = opts.syncDelete;
    this.disableSyncDeleteGuard = opts.disableSyncDeleteGuard;
    this.dryRun = opts.dryRun;

    var client;
    if (opts.client) {
        assert.object(opts.client, 'opts.client');
        client = opts.client;
    } else if (opts.clientOpts) {
        assert.object(opts.clientOpts, 'opts.clientOpts');
        assert.string(opts.clientOpts.url, 'opts.clientOpts.url');
        assert.string(opts.clientOpts.user, 'opts.clientOpts.user');
        assert.optionalString(opts.clientOpts.subuser,
            'opts.clientOpts.subuser');
        assert.optionalBool(opts.clientOpts.insecure,
            'opts.clientOpts.insecure');
        /*
         * Just client node-manta's `createClient()`: `clientOpts.sign` can be
         * empty, a signing function, or an object with:
         * - `keyId`: the key fingerprint
         * - `key`: a path to the private SSH key
         */
    }

    if (opts.client) {
        this.client = opts.client;
        this._closeClient = false;
    } else if (opts.clientOpts) {
        var clientOpts = objCopy(opts.clientOpts);
        if (!clientOpts.log) {
            clientOpts.log = this.log;
        }
        this.client = manta.createClient(clientOpts);
        this._closeClient = true;
    } else {
        this.client = manta.createClient({
            log: this.log,
            sign: manta.cliSigner({
                keyId: process.env.MANTA_KEY_ID,
                user: process.env.MANTA_USER,
                subuser: process.env.MANTA_SUBUSER
            }),
            user: process.env.MANTA_USER,
            url: process.env.MANTA_URL,
            insecure: Boolean(process.env.MANTA_TLS_INSECURE)
        });
        this._closeClient = true;
    }

    this._state = null;
    self._pollTimeout = null;
    self._lastPollTime = null;
    self._buffer = [];
    self._paused = true;

    this.log.trace({intervalMs: this.intervalMs}, 'MantaDirWatcher created');
}
util.inherits(MantaDirWatcher, Readable);

MantaDirWatcher.prototype.close = function close() {
    if (this.client && this._closeClient) {
        this.client.close();
    }
    if (this._pollTimeout) {
        clearTimeout(this._pollTimeout);
        this._pollTimeout = null;
    }
    this.push(null);
};

/*
 * Downstream is ready to get events: push any data we have buffered
 * and resume polling.
 */
MantaDirWatcher.prototype._read = function _read() {
    this._resume();
};

MantaDirWatcher.prototype._resume = function _resume() {
    var self = this;
    if (!this._paused) {
        return;
    }

    this._paused = false;

    // Flush buffer.
    while (this._buffer.length > 0) {
        if (!this.push(this._buffer.shift())) {
            this._pause();
            return;
        }
    }

    // Resume polling.
    if (!this._pollTimeout) {
        var now = Date.now();
        var timeToNextPoll = (this._lastPollTime
            ? (this._lastPollTime + this.intervalMs) - now
            : 0);
        this.log.trace({timeToNextPoll: timeToNextPoll}, '_resume: poll time');
        if (timeToNextPoll <= 0) {
            setImmediate(function () {
                self._poll();
            });
        } else {
            this._pollTimeout = setTimeout(function () {
                self._poll();
            }, timeToNextPoll);
        }
    }
};

MantaDirWatcher.prototype._pause = function _pause() {
    this._paused = true;

    if (this._pollTimeout) {
        clearTimeout(this._pollTimeout);
        this._pollTimeout = null;
    }
};

/*
 * Poke this watcher to poll now, rather than waiting for the coming
 * poll interval.
 */
MantaDirWatcher.prototype.poke = function poke() {
    var self = this;

    if (this._pollTimeout) {
        clearTimeout(this._pollTimeout);
        this._pollTimeout = null;
    }

    setImmediate(function pokeIt() {
        self._poll();
    });
};

MantaDirWatcher.prototype._poll = function _poll() {
    var self = this;
    var log = self.log;
    var context = {
        oldState: self._state,
        newState: {},
        dirents: [],
        localDirents: [],
        changes: []
    };

    vasync.pipeline({arg: context, funcs: [
        function listDir(arg, next) {
            var handleDirent = function (dirent) {
                if (self.filter.type && dirent.type !== self.filter.type) {
                    return;
                }
                if (self.filter.name && !self.filter.name.test(dirent.name)) {
                    return;
                }
                arg.newState[dirent.name] = dirent;
                arg.dirents.push(dirent);
            };

            self.client.ls(self.dir, function (err, res) {
                if (err) {
                    if (err.statusCode === 404) {
                        next();
                    } else {
                        next(err);
                    }
                    return;
                }

                res.on('object', handleDirent);
                res.on('directory', handleDirent);
                res.once('end', function () {
                    next();
                });
            });
        },

        /*
         * If this is the first poll and we have a local `syncDir`, then
         * we will be comparing against that dir: collect the local dirents.
         */
        function firstRunLocalDirents(arg, next) {
            if (!self.syncDir || self.oldState) {
                next();
                return;
            }

            fs.readdir(self.syncDir, function (err, names) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        next();
                    } else {
                        next(err);
                    }
                    return;
                }

                if (self.filter.name) {
                    names = names.filter(function (name) {
                        return self.filter.name.test(name);
                    });
                }

                vasync.forEachPipeline({
                    inputs: names,
                    func: function lstatOne(name, nextName) {
                        var path = mod_path.join(self.syncDir, name);
                        fs.lstat(path, function (err, stat) {
                            if (err) {
                                nextName(err);
                                return;
                            }
                            if (!stat.isDirectory()) {
                                arg.localDirents.push({
                                    name: name,
                                    path: path,
                                    stat: stat
                                });
                            }
                            nextName();
                        });
                    }
                }, function (err) {
                    log.trace({localDirents: arg.localDirents}, 'localDirents');
                    next(err);
                });
            });
        },

        function changesFromDirents(arg, next) {
            var i, ld, name, dirent;

            if (arg.oldState) {
                // Compare against `oldState`.
                for (i = 0; i < arg.dirents.length; i++) {
                    dirent = arg.dirents[i];
                    name = dirent.name;
                    var oldDirent = arg.oldState[name];
                    if (!oldDirent) {
                        arg.changes.push({action: 'create', dirent: dirent});
                    } else if (diffDirents(oldDirent, dirent)) {
                        arg.changes.push({action: 'update', dirent: dirent,
                            oldDirent: oldDirent});
                    }
                }
                var oldNames = Object.keys(arg.oldState);
                for (i = 0; i < oldNames.length; i++) {
                    var n = oldNames[i];
                    if (!arg.newState[n]) {
                        arg.changes.push({action: 'delete',
                            oldDirent: arg.oldState[n]});
                    }
                }
                log.trace({changes: arg.changes},
                    'changesFromDirents: compare to oldState');
                next();

            } else if (self.syncDir) {
                // Compare against `localDirents` from syncDir.

                var localDirentFromName = {};
                for (i = 0; i < arg.localDirents.length; i++) {
                    ld = arg.localDirents[i];
                    localDirentFromName[ld.name] = ld;
                    if (!arg.newState[ld.name]) {
                        arg.changes.push({action: 'delete',
                            oldLocalDirent: ld});
                    }
                }

                arg.possibleUpdates = [];
                for (i = 0; i < arg.dirents.length; i++) {
                    dirent = arg.dirents[i];
                    name = dirent.name;
                    var localDirent = localDirentFromName[name];
                    if (!localDirent) {
                        arg.changes.push({action: 'create', dirent: dirent});
                    } else {
                        arg.possibleUpdates.push(name);
                    }
                }

                vasync.forEachPipeline({
                    inputs: arg.possibleUpdates,
                    func: function checkPossibleUpdate(name, nextName) {
                        dirent = arg.newState[name];
                        var path = dirent.parent + '/' + name;
                        var localDirent = localDirentFromName[name];
                        var localPath = mod_path.join(self.syncDir, name);
                        log.trace({path: path, localPath: localPath},
                            'checkPossibleUpdate');
                        self.client.info(path, function (err, info) {
                            if (err) {
                                nextName(err);
                                return;
                            }
                            if (info.size !== localDirent.stat.size) {
                                arg.changes.push({action: 'update',
                                    dirent: dirent,
                                    oldLocalDirent: localDirent});
                                log.trace({size: info.size,
                                    localSize: localDirent.stat.size},
                                    'checkPossibleUpdate: size diff');
                                nextName();
                            } else {
                                // Compare md5.
                                var md5sum = crypto.createHash('md5');
                                var input = fs.createReadStream(localPath);
                                input.on('data', function (chunk) {
                                    md5sum.update(chunk);
                                });
                                input.on('end', function () {
                                    var localMd5 = md5sum.digest('base64');
                                    if (localMd5 !== info.md5) {
                                        arg.changes.push({action: 'update',
                                            dirent: dirent,
                                            oldLocalDirent: localDirent});
                                        log.trace({md5: info.md5,
                                            localMd5: localMd5},
                                            'checkPossibleUpdate: md5 diff');
                                    }
                                    nextName();
                                });
                            }
                        });
                    }
                }, function (err) {
                    log.trace({changes: arg.changes},
                        'changesFromDirents: compare to localDirents');
                    next(err);
                });

            } else {
                // Nothing to compare against.
                log.trace('changesFromDirents: first poll, intializing');
                next();
            }
        },

        /*
         * When doing syncing with `syncDelete`, we have a sanity guard
         * to protect against deleting all (or many) files in the given
         * `syncDir` if it looks like a mischosen local dir.
         */
        function firstRunSyncDeleteGuard(arg, next) {
            if (!self.syncDir || !self.syncDelete
                || arg.oldState || self.disableSyncDeleteGuard)
            {
                next();
                return;
            }

            assert.arrayOfString(arg.possibleUpdates, 'arg.possibleUpdates');

            var deleteNames = [];
            arg.changes.forEach(function (ch) {
                if (ch.action === 'delete') {
                    deleteNames.push(ch.oldLocalDirent.name);
                }
            });

            /*
             * `deleteNames` entries means we will be deleting local files.
             * Empty `possibleUpdates` means there were no matching names
             * between local and manta dirs -- in other words, there is no
             * sign here that `syncDir` isn't an accident.
             */
            if (deleteNames.length > 0 && arg.possibleUpdates.length === 0) {
                next(new Error(format('sync-delete-guard failure: '
                    + 'Are you sure syncDir="%s" is correct for syncing '
                    + 'from dir="%s"; %d local file%s (%s) would be deleted '
                    + 'and there are no filename matches between "syncDir" '
                    + 'and "dir" to indicate syncDir is correct. (Use the '
                    + '"disableSyncDeleteGuard" option to override this '
                    + 'guard.)', self.syncDir, self.dir, deleteNames.length,
                    (deleteNames.length === 1 ? '' : 's'),
                    deleteNames.join(', '))));
            } else {
                log.trace({numDeletes: deleteNames.length,
                    numNameMatches: arg.possibleUpdates.length},
                    'passed sync-delete-guard');
                next();
            }
        },

        function syncChanges(arg, next) {
            if (!self.syncDir || self.dryRun) {
                next();
                return;
            }

            vasync.forEachPipeline({
                inputs: arg.changes,
                func: function syncChange(change, nextChange) {
                    switch (change.action) {
                        case 'update':
                        case 'create':
                            self._syncDirent(change.dirent, nextChange);
                            break;
                        case 'delete':
                            if (self.syncDelete) {
                                var localPath = (change.oldDirent
                                    ? change.oldDirent.parent + '/'
                                        + change.oldDirent.name
                                    : change.oldLocalDirent.path);
                                log.trace({localPath: localPath}, 'rm');
                                rimraf(localPath, nextChange);
                            } else {
                                nextChange();
                            }
                            break;
                        default:
                            throw new Error('unknown change action: '
                                + change.action);
                    }
                }
            }, function finishSyncChanges(err) {
                next(err);
            });
        },

        function pushEvents(arg, next) {
            var timeEvent = new Date().toISOString();

            var events = [];
            for (var i = 0; i < arg.changes.length; i++) {
                var change = arg.changes[i];
                var aDirent = (change.dirent || change.oldDirent
                    || change.oldLocalDirent);
                var name = aDirent.name;
                var path = self.dir + '/' + name;
                var event = {
                    timeEvent: timeEvent,
                    action: change.action,
                    name: name,
                    path: path
                };
                switch (change.action) {
                    case 'update':
                        event.mtime = change.dirent.mtime;
                        break;
                    case 'create':
                        event.mtime = change.dirent.mtime;
                        break;
                    case 'delete':
                        break;
                    default:
                        throw new Error('unknown change action: '
                            + change.action);
                }
                events.push(event);
            }

            if (events.length > 0) {
                var group = {events: events};
                if (self._paused) {
                    log.trace({group: group}, 'pushEvents: buffering events');
                    self._buffer.push(group);
                } else {
                    log.trace({group: group}, 'pushEvents: pushing events');
                    if (!self.push(group)) {
                        self._pause();
                    }
                }
            }
            next();
        },

        function saveStateAndScheduleNextPoll(arg, next) {
            self._state = arg.newState;

            // Schedule next poll.
            self._lastPollTime = Date.now();  // time we *completed* last poll
            if (!self._paused) {
                self._pollTimeout = setTimeout(function () {
                    self._poll();
                }, self.intervalMs);
                log.trace({delay: self.intervalMs}, 'schedule next poll');
            }

            next();
        }

    ]}, function finishPoll(err) {
        log.trace({err: err}, '_poll: end');
        if (err) {
            self.emit('error', err);
        }
    });
};


MantaDirWatcher.prototype._syncDirent = function _syncDirent(dirent, cb) {
    assert.object(dirent, 'dirent');
    assert.func(cb, 'cb');

    var self = this;
    var log = self.log;
    var name = dirent.name;
    var tmpLocalPath = mod_path.join(self.syncDir,
        '.' + name + '.mwatchdirpart');
    var localPath = mod_path.join(self.syncDir, name);
    var path = dirent.parent + '/' + name;

    vasync.pipeline({funcs: [
        function mkdirpSyncDir(_, next) {
            mkdirp(self.syncDir, next);
        },
        function downloadToTmpFile(_, next) {
            self.client.get(path, function (err, src) {
                var out = fs.createWriteStream(tmpLocalPath);
                out.on('finish', function () {
                    next();
                });
                src.pipe(out);
            });
        },
        function moveInPlace(_, next) {
            log.trace({localPath: localPath}, 'sync');
            fs.rename(tmpLocalPath, localPath, next);
        }
    ]}, function (err) {
        if (err) {
            rimraf(tmpLocalPath, function (_) {
                cb(err);
            });
        } else {
            cb();
        }
    });

};


// ---- exports

module.exports = MantaDirWatcher;
module.exports.FILTER_TYPES = FILTER_TYPES;
