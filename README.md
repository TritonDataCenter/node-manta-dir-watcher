A node.js library to watch a Manta directory for file changes.

Minimally you give a `MantaDirWatcher` Manta connection & auth info, a Manta
dir to watch, and a period and it will poll the Manta directory and emit an
event each time a file (a.k.a. a Manta object) or directory is added, removed,
or changed.  The sweet spot for this module (currently at least) is a Manta
directory of relatively few (and if using the sync option, relatively small)
files.

Optional features:
- Glob/regex pattern to limit to a subset of files in the dir (via the
  `namePattern` option).
- *Sync* down the files to a local dir (via the `syncDir` option).

Limitations:
- This doesn't handle recursively looking in Manta dirs.


# Install

    npm install manta-dir-watcher


# Usage

In node.js code:

```javascript
var MantaDirWatcher = require('manta-dir-watcher');
var watcher = new MantaDirWatcher({
    // By default Manta connection options are picked up from `MANTA_*` envvars
    // or `clientOpts` or `client` can be passed in.

    dir: <dir to watch>,

    // Optional params:
    groupEvents: <set to true to have all events for a single poll be
        returned in one group>,
    namePattern: <glob string or regex to match against file/dir names>,
    syncDir: <local dir to which to sync found files>,

    log: <optional bunyan logger>
});

watcher.on('data', function (event) {
    console.log(event);
});
```

CLI:

```
$ ./bin/mwatchdir -i 5 /trent.mick/stor/tmp
{"action":"update","name":"foo.json","path":"/trent.mick/stor/tmp/foo.json"}
{"action":"create","name":"hi.txt","path":"/trent.mick/stor/tmp/hi.txt"}
{"action":"delete","name":"hi.txt","path":"/trent.mick/stor/tmp/hi.txt"}
```


# License

MPL-2. See [LICENSE](./LICENSE).
