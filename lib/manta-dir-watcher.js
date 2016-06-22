/*
 * Copyright 2016 Trent Mick
 * Copyright 2016 Joyent, Inc.
 */

var assert = require('assert-plus');
var events = require('events');
var util = require('util');


// ---- globals


// ---- internal support stuff

function objCopy(obj, target) {
    if (!target) {
        target = {};
    }
    Object.keys(obj).forEach(function (k) {
        target[k] = obj[k];
    });
    return target;
}


// ---- MantaDirWatcher class

function MantaDirWatcher(opts) {

};


// ---- exports

module.exports = {
    MantaDirWatcher: MantaDirWatcher
};
