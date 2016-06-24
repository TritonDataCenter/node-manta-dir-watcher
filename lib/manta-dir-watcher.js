/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');
var manta = require('manta');
var Readable = require('stream').Readable;
var util = require('util');
var vstream = require('vstream');


// ---- internal support stuff


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
 * @param {Boolean} opts.groupEvents: Optional, default false. If true, then
 *      all events from one poll will be grouped into a single emitted
 *      object: `{"events": [...]}`
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
    assert.optionalBool(opts.groupEvents, 'opts.groupEvents');

    // TODO other stream options? highWaterMark?
    Readable.call(this, {objectMode: true});
    vstream.wrapStream(this, {name: 'MantaDirWatcher'});

    this.dir = opts.dir;
    this.log = (opts.log
        ? opts.log.child({dir: this.dir}, true)
        : bunyan.createLogger({name: 'manta-dir-watcher', dir: this.dir}));
    this.groupEvents = opts.groupEvents;

    var client;
    if (opts.client) {
        assert.object(opts.client, 'opts.client');
        client = opts.client
    } else if (opts.clientOpts) {
        assert.object(opts.clientOpts, 'opts.clientOpts');
        assert.string(opts.clientOpts.url, 'opts.clientOpts.url');
        assert.string(opts.clientOpts.user, 'opts.clientOpts.user');
        assert.string(opts.clientOpts.subuser, 'opts.clientOpts.subuser');
        assert.string(opts.clientOpts.keyId, 'opts.clientOpts.keyId');
        assert.optionalBool(opts.clientOpts.insecure,
            'opts.clientOpts.insecure');
    }

    if (opts.client) {
        this.client = opts.client;
        this._closeClient = false;
    } else if (opts.clientOpts) {
        this.client = manta.createClient({
            log: this.log,
            sign: manta.cliSigner({
                keyId: opts.clientOpts.keyId,
                user: opts.clientOpts.user,
                subuser: opts.clientOpts.subuser
            }),
            user: opts.clientOpts.user,
            url: opts.clientOpts.url,
            insecure: opts.clientOpts.insecure
        });
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

    this.log.debug({intervalMs: this.intervalMs}, 'MantaDirWatcher created');
};
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
        this.log.debug({timeToNextPoll: timeToNextPoll}, '_resume: poll time');
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

MantaDirWatcher.prototype._poll = function _poll() {
    var self = this;
    var oldState = this._state;
    var newState = {};
    var initializingState = !oldState;
    var groupedEvents = [];

    var eventFromHit = function (action, oldHit, newHit, diff) {
        var hit = newHit || oldHit;
        return {
            time: new Date().toISOString(),
            action: action,
            name: hit.name,
            path: hit.parent + '/' + hit.name
            // TODO: add other info? new and old hit values? diff specifics
        };
    };

    var diffHits = function (oldHit, newHit) {
        var isDiff = false;
        var diff = {};
        ['type', 'etag'].forEach(function (attr) {
            if (oldHit[attr] !== newHit[attr]) {
                diff[attr] = [oldHit[attr], newHit[attr]];
                isDiff = true;
            }
        });
        if (isDiff) {
            return diff;
        } else {
            return null;
        }
    };

    var pushEvent = function (event) {
        if (self.groupEvents) {
            groupedEvents.push(event);
        } else if (self._paused) {
            self._buffer.push(event);
        } else {
            if (!self.push(event)) {
                self._pause();
            }
        }
    };

    var handleHit = function (hit) {
        var name = hit.name;
        newState[name] = hit;

        if (!initializingState) {
            stateHit = oldState[name];
            if (!stateHit) {
                pushEvent( eventFromHit('create', null, hit) );
            } else {
                var diff = diffHits(stateHit, hit);
                if (diff) {
                    pushEvent( eventFromHit('update', stateHit, hit, diff) );
                }
            }
        }
    };

    var finish = function () {
        if (!initializingState) {
            // Look for 'delete' events.
            var missingNames = [];
            var stateNames = Object.keys(oldState);
            for (var i = 0; i < stateNames.length; i++) {
                var n = stateNames[i];
                if (!newState[n]) {
                    pushEvent( eventFromHit('delete', oldState[n]) );
                }
            }

            if (self.groupEvents && groupedEvents.length > 0) {
                var group = {events: groupedEvents};
                if (!self.push(group)) {
                    self._pause();
                }
            }
        }

        self._state = newState;

        // Schedule next poll.
        self._lastPollTime = Date.now();  // time we *completed* last poll
        if (!self._paused) {
            self._pollTimeout = setTimeout(function () {
                self._poll();
            }, self.intervalMs);
        }

        self.log.debug('_poll: end');
    };


    this.client.ls(this.dir, function (err, res) {
        if (err) {
            self.emit('error', err);
            return;
        }

        res.on('object', handleHit);
        res.on('directory', handleHit);
        res.once('end', finish);
    });

};


// ---- exports

module.exports = MantaDirWatcher;
