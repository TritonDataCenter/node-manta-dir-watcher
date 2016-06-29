A node.js library to watch a Manta directory for file changes.

Minimally you give a `MantaDirWatcher` Manta connection & auth info, a Manta
dir to watch, and a period and it will poll the Manta directory and emit an
event each time a file (a.k.a. a Manta object) or directory is added, removed,
or changed.  The sweet spot for this module (currently at least) is a Manta
directory of relatively few (and if using the sync option, relatively small)
files.

Optional features:
- Glob/regex pattern to limit to a subset of files in the dir (via
  `filter.name` option).
- Limit to just objects or directories (via `filter.type` option).
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
    dir: <dir to watch>,

    // Optional connection params:
    // By default Manta connection options are picked up from `MANTA_*` envvars
    // or `clientOpts` or `client` can be passed in.

    // Optional params:
    interval: <poll interval in seconds, default is 60s>,
    filter: {
        name: <glob string or regex to match against file/dir names>,
        type: <"object" or "directory" to limit to just that type>
    },
    syncDir: <local dir to which to sync found files>,
    syncDelete: <set `true` to allow deletion of files in the local syncDir>,

    log: <optional bunyan logger>
});

watcher.on('data', function (group) {
    console.log(group);
});
```

CLI:

```
$ ./bin/mwatchdir -i 5 -n '*.txt' /trent.mick/stor/tmp/a
ACTION  TIMEEVENT                 MTIME                     PATH
create  2016-06-29T18:13:29.120Z  2016-06-29T18:13:26.672Z  /trent.mick/stor/tmp/a/e.txt
delete  2016-06-29T18:13:45.494Z  -                         /trent.mick/stor/tmp/a/d.txt
create  2016-06-29T18:13:50.981Z  2016-06-29T18:13:46.980Z  /trent.mick/stor/tmp/a/f.txt
update  2016-06-29T18:14:01.918Z  2016-06-29T18:13:58.210Z  /trent.mick/stor/tmp/a/f.txt
create  2016-06-29T18:14:07.396Z  2016-06-29T18:14:02.037Z  /trent.mick/stor/tmp/a/g.txt
```


# License

MPL-2. See [LICENSE](./LICENSE).


# Developer Notes

An example for looking at trace logging (dropping the somewhat noisy manta
client traffic):

    bin/mwatchdir -i 5 -v /trent.mick/stor/tmp/a -n '*.txt' 2>&1 | bunyan -c 'this.component !== "MantaClient"'
