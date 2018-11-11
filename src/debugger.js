'use strict'
/*
    Debugger: thin wrapper around other classes to manage debug connections
*/
const _JDWP = require('./jdwp')._JDWP;
const { ADBClient } = require('./adbclient');
const $ = require('./jq-promise');
const { D } = require('./util');

function Debugger() {
    this.connection = null;
    this.ons = {};
    this.breakpoints = { all: [], enabled: {}, bysrcloc: {} };
    this.exception_ids = [];
    this.JDWP = new _JDWP();
    this.session = null;
    this.globals = Debugger.globals;
}

Debugger.globals = {
    portrange: { lowest: 31000, highest: 31099 },
    inuseports: [],
    debuggers: {},
    reserveport: function () {
        // choose a random port to use each time
        for (var i = 0; i < 10000; i++) {
            var portidx = ((Math.random() * 100) | 0);
            if (this.inuseports.includes(portidx))
                continue;   // try again
            this.inuseports.push(portidx);
            return this.portrange.lowest + portidx;
        }
    },
    freeport: function (port) {
        var iuidx = this.inuseports.indexOf(port - this.portrange.lowest);
        if (iuidx >= 0) this.inuseports.splice(iuidx, 1);
    }
};

Debugger.prototype = {

    on: function (which, context, data, fn) {
        if (!fn && !data && typeof (context) === 'function') {
            fn = context; context = data = null;
        }
        else if (!fn && typeof (data) === 'function') {
            fn = data; data = null;
        }
        if (!this.ons[which]) this.ons[which] = [];
        this.ons[which].push({
            context: context, data: data, fn: fn
        });
        return this;
    },

    _trigger: function (which, e) {
        var k = this.ons[which];
        if (!k || !k.length) return this;
        k = k.slice();
        e = e || {};
        e.dbgr = this;
        for (var i = 0; i < k.length; i++) {
            e.data = k[i].data;
            try { k[i].fn.call(k[i].context, e) }
            catch (ex) {
                D('Exception in event trigger: ' + ex.message);
            }
        }
        return this;
    },

    startDebugSession(build, deviceid, launcherActivity) {
        return this.newSession(build, deviceid)
            .runapp('debug', launcherActivity, this)
            .then(function (deviceid) {
                return this.getDebuggablePIDs(this.session.deviceid, this);
            })
            .then(function (pids, dbgr) {
                // choose the last pid in the list
                var pid = pids[pids.length - 1];
                // after connect(), the caller must call resume() to begin
                return dbgr.connect(pid, dbgr);
            })
    },

    runapp(action, launcherActivity) {
        // older (<3) versions of Android only allow target components to be specified with -n
        var launchcmdparams = ['--activity-brought-to-front', '-a android.intent.action.MAIN', '-c android.intent.category.LAUNCHER', '-n ' + this.session.build.pkgname + '/' + launcherActivity];
        if (action === 'debug') {
            launchcmdparams.splice(0, 0, '-D');
        }
        var x = {
            dbgr: this,
            shell_cmd: {
                command: 'am start ' + launchcmdparams.join(' '),
                untilclosed: true,
            },
            retries: {
                count: 10, pause: 1000,
            },
            deviceid: this.session.deviceid,
            deferred: $.Deferred(),
        };
        tryrunapp(x);
        function tryrunapp(x) {
            var adb = new ADBClient(x.deviceid);
            adb.shell_cmd(x.shell_cmd)
                .then(function (stdout) {
                    // failures:
                    //  Error: Activity not started...
                    var m = stdout.match(/Error:.*/g);
                    if (m) {
                        if (--x.retries.count) {
                            setTimeout(function (o) {
                                tryrunapp(o);
                            }, x.retries.pause, x);
                            return;
                        }
                        return x.deferred.reject({ cat: 'cmd', msg: m[0] });
                    }
                    // running the JDWP command so soon after launching hangs, so give it a breather before continuing
                    setTimeout(x => {
                        x.deferred.resolveWith(x.dbgr, [x.deviceid])
                    }, 1000, x);
                })
                .fail(function (err) {
                });
        }
        return x.deferred;
    },

    newSession: function (build, deviceid) {
        this.session = {
            build: build,
            deviceid: deviceid,
            apilevel: 0,
            adbclient: null,
            stoppedlocation: null,
            classes: {},
            // classprepare filters
            cpfilters: [],
            preparedclasses: [],
            stepids: {},    // hashmap<threadid,stepid>
            threadsuspends: [], // hashmap<threadid, suspend-count>
            invokes: {},        // hashmap<threadid, deferred>
        }
        return this;
    },

    /* return a list of deviceids available for debugging */
    list_devices: function (extra) {
        return new ADBClient().list_devices(extra);
    },

    getDebuggablePIDs: function (deviceid, extra) {
        return new ADBClient(deviceid).jdwp_list({
            ths: this,
            extra: extra,
        })
    },

    getDebuggableProcesses: function (deviceid, extra) {
        var info = {
            debugger: this,
            adbclient: new ADBClient(deviceid),
            extra: extra,
        };
        return info.adbclient.jdwp_list({
            ths: this,
            extra: info,
        })
            .then(function (jdwps, info) {
                if (!jdwps.length)
                    return $.Deferred().resolveWith(this, [[], info.extra]);
                info.jdwps = jdwps;
                // retrieve the ps list from the device
                return info.adbclient.shell_cmd({
                    ths: this,
                    extra: info,
                    command: 'ps',
                    untilclosed: true,
                }).then(function (stdout, info) {
                    // output should look something like...
                    // USER     PID   PPID  VSIZE  RSS     WCHAN    PC        NAME
                    // u0_a153   32721 1452  1506500 37916 ffffffff 00000000 S com.example.somepkg
                    // but we cope with variations so long as PID and NAME exist
                    var lines = stdout.split(/\r?\n|\r/g);
                    var hdrs = (lines.shift() || '').trim().toUpperCase().split(/\s+/);
                    var pidindex = hdrs.indexOf('PID');
                    var nameindex = hdrs.indexOf('NAME');
                    var result = { deviceid: info.adbclient.deviceid, name: {}, jdwp: {}, all: [] };
                    if (pidindex < 0 || nameindex < 0)
                        return $.Deferred().resolveWith(null, [[], info.extra]);
                    // scan the list looking for matching pids...
                    for (var i = 0; i < lines.length; i++) {
                        var entries = lines[i].trim().replace(/ [S] /, ' ').split(/\s+/);
                        if (entries.length != hdrs.length) continue;
                        var jdwpidx = info.jdwps.indexOf(entries[pidindex]);
                        if (jdwpidx < 0) continue;
                        // we found a match
                        var entry = {
                            jdwp: entries[pidindex],
                            name: entries[nameindex],
                        };
                        result.all.push(entry);
                        result.name[entry.name] = entry;
                        result.jdwp[entry.jdwp] = entry;
                    }
                    return $.Deferred().resolveWith(this, [result, info.extra]);
                })
            });
    },

    /* attach to the debuggable pid
        Quite a lot happens in this - we setup port forwarding, complete the JDWP handshake,
        setup class loader notifications and call anyone waiting for us.
        If anything fails, we call disconnect() to return to a sense of normality.
    */
    connect: function (jdwpid, extra) {
        switch (this.status()) {
            case 'connected':
                // already connected - just resolve
                return $.Deferred().resolveWith(this, [extra]);
            case 'connecting':
                // wait for the connection to complete (or fail)
                var x = { deferred: $.Deferred(), extra: extra };
                this.connection.connectingpromises.push(x);
                return x.deferred;
            default:
                if (!jdwpid)
                    return $.Deferred().rejectWith(this, [new Error('Debugger not connected')]);
                break;
        }

        var info = {
            dbgr: this,
            extra: extra,
        };

        // from this point on, we are in the "connecting" state until the JDWP handshake is complete
        // (and we mark as connected) or we fail and return to the disconnected state
        this.connection = {
            jdwp: jdwpid,
            localport: this.globals.reserveport(),
            portforwarding: false,
            connected: false,
            connectingpromises: [],
        };

        // setup port forwarding
        return new ADBClient(this.session.deviceid).jdwp_forward({
            ths: this,
            extra: info,
            localport: this.connection.localport,
            jdwp: this.connection.jdwp,
        })
            .then(function (info) {
                this.connection.portforwarding = true;
                // after this, the client keeps an open connection until
                // jdwp_disconnect() is called
                this.session.adbclient = new ADBClient(this.session.deviceid);
                return this.session.adbclient.jdwp_connect({
                    ths: this,
                    extra: info,
                    localport: this.connection.localport,
                    onreply: this._onjdwpmessage,
                });
            })
            .then(function (info) {
                // handshake has completed
                this.connection.connected = true;
                // call suspend first - we shouldn't really need to do this (as the debugger
                // is already suspended and will not resume until we tell it), but if we
                // don't do this, it logs a complaint...
                return this.suspend();
            })
            .then(function () {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    cmd: this.JDWP.Commands.idsizes(),
                });
            })
            .then(function (idsizes) {
                // set the class loader event notifier so we can set breakpoints...
                this.JDWP.setIDSizes(idsizes);
                return this._initbreakpoints();
            })
            .then(function () {
                return new ADBClient(this.session.deviceid).shell_cmd({
                    ths: this,
                    command: 'getprop ro.build.version.sdk',
                });
            })
            .then(function (apilevel) {
                this.session.apilevel = apilevel.trim();
                // at this point, we are ready to go - all the caller needs to do is call resume().
                // resolve all the connection promises for those waiting on us (usually none)
                var cp = this.connection.connectingpromises;
                var deferreds = [this, info];
                delete this.connection.connectingpromises;
                for (var i = 0; i < cp.length; i++) {
                    deferreds.push(cp[i].deferred);
                    cp[i].deferred.resolveWith(this, [cp[i].extra]);
                }
                return $.when.apply($, deferreds).then(function (dbgr, info) {
                    return $.Deferred().resolveWith(dbgr, [info.extra]);
                })
            })
            .then(function () {
                this._trigger('connected');
            })
            .fail(function (err) {
                this.connection.err = err;
                // force a return to the disconnected state
                this.disconnect();
            })
    },

    _onjdwpmessage: function (data) {
        // decodereply will resolve the promise associated with
        // any command this reply is in response to.
        var reply = this.JDWP.decodereply(this, data);
        if (reply.isevent) {
            if (reply.decoded.events && reply.decoded.events.length) {
                switch (reply.decoded.events[0].kind.value) {
                    case 100:
                        // vm disconnected - sent by plugin
                        this.disconnect();
                        break;
                }
            }
        }
    },

    ensureconnected: function (extra) {
        // passing null as the jdwpid will cause a fail if the client is not connected (or connecting)
        return this.connect(null, extra);
    },

    status: function () {
        if (!this.connection) return "disconnected";
        if (this.connection.connected) return "connected";
        return "connecting";
    },

    forcestop: function (extra) {
        return this.ensureconnected()
            .then(function () {
                return new ADBClient(this.session.deviceid).shell_cmd({
                    command: 'am force-stop ' + this.session.build.pkgname,
                });
            })
    },

    disconnect: function (extra) {
        // disconnect is called from a variety of failure scenarios
        // so it must be fairly robust in how it undoes stuff
        const current_state = this.status();
        if (!this.connection)
            return $.Deferred().resolveWith(this, [current_state, extra]);

        var info = {
            connection: this.connection,
            current_state: current_state,
            extra: extra,
        };
        // from here on in, this instance is in the disconnected state
        this.connection = null;

        // fail any waiting for the connection to complete
        var cp = info.connection.connectingpromises;
        if (cp) {
            for (var i = 0; i < cp.length; i++) {
                cp[i].deferred.rejectWith(this, [info.connection.err]);
            }
        }

        // reset the breakpoint states
        this._finitbreakpoints();

        this._trigger('disconnect');

        // perform the JDWP disconnect
        info.jdwpdisconnect = info.connection.connected
            ? this.session.adbclient.jdwp_disconnect({ ths: this, extra: info })
            : $.Deferred().resolveWith(this, [info]);

        return info.jdwpdisconnect
            .then(function (info) {
                this.session.adbclient = null;
                // undo the portforwarding
                // todo: replace remove_all with remove_port
                info.pfremove = info.connection.portforwarding
                    ? new ADBClient(this.session.deviceid).forward_remove_all({ ths: this, extra: info })
                    : $.Deferred().resolveWith(this, [info]);

                return info.pfremove;
            })
            .then(function (info) {
                // mark the port as freed
                if (info.connection.portforwarding) {
                    this.globals.freeport(info.connection.localport)
                }
                this.session = null;
                return $.Deferred().resolveWith(this, [info.current_state, info.extra]);
            });
    },

    allthreads: function (extra) {
        return this.ensureconnected(extra)
            .then(function (extra) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: extra,
                    cmd: this.JDWP.Commands.allthreads(),
                });
            });
    },

    threadinfos: function(thread_ids, extra) {
        if (!Array.isArray(thread_ids))
            thread_ids = [thread_ids];
        var o = {
            dbgr: this, thread_ids, extra, threadinfos:[], idx:0,
            next() {
                var thread_id = this.thread_ids[this.idx];
                if (typeof(thread_id) === 'undefined')
                    return $.Deferred().resolveWith(this.dbgr, [this.threadinfos, this.extra]);
                var info = {
                    threadid: thread_id,
                    name:'',
                    status:null,
                };
                return this.dbgr.session.adbclient.jdwp_command({ ths:this.dbgr, extra:info, cmd:this.dbgr.JDWP.Commands.threadname(info.threadid) })
                    .then((name,info) => {
                        info.name = name;
                        return this.dbgr.session.adbclient.jdwp_command({ ths:this.dbgr, extra:info, cmd:this.dbgr.JDWP.Commands.threadstatus(info.threadid) })
                    })
                    .then((status, info) => {
                        info.status = status;
                        this.threadinfos.push(info);
                    })
                    .always(() => (this.idx++,this.next()))
            }
        };
        return this.ensureconnected(o).then(o => o.next());
    },

    suspend: function (extra) {
        return this.ensureconnected(extra)
            .then(function (extra) {
                this._trigger('suspending');
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: extra,
                    cmd: this.JDWP.Commands.suspend(),
                });
            })
            .then(function () {
                this._trigger('suspended');
            });
    },

    suspendthread: function (threadid, extra) {
        return this.ensureconnected({threadid,extra})
            .then(function (x) {
                this.session.threadsuspends[x.threadid] = (this.session.threadsuspends[x.threadid]|0) + 1;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x.extra,
                    cmd: this.JDWP.Commands.suspendthread(x.threadid),
                });
            })
            .then((res,extra) => extra);
    },

    _resume:function(triggers, extra) {
        return this.ensureconnected(extra)
            .then(function (extra) {
                if (triggers) this._trigger('resuming');
                this.session.stoppedlocation = null;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: extra,
                    cmd: this.JDWP.Commands.resume(),
                });
            })
            .then(function (decoded, extra) {
                if (triggers) this._trigger('resumed');
                return extra;
            });
    },

    resume: function (extra) {
        return this._resume(true, extra);
    },

    _resumesilent: function () {
        return this._resume(false);
    },

    resumethread: function (threadid, extra) {
        return this.ensureconnected({threadid,extra})
            .then(function (x) {
                this.session.threadsuspends[x.threadid] = (this.session.threadsuspends[x.threadid]|0) - 1;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x.extra,
                    cmd: this.JDWP.Commands.resumethread(x.threadid),
                });
            })
            .then((res,extra) => extra);
    },

    step: function (steptype, threadid, extra) {
        var x = { steptype, threadid, extra };
        return this.ensureconnected(x)
            .then(function (x) {
                this._trigger('stepping');
                return this._setupstepevent(x.steptype, x.threadid, x);
            })
            .then(x => {
                return this.resumethread(x.threadid, x.extra);
            });
    },

    _splitsrcfpn: function (srcfpn) {
        var m = srcfpn.match(/^\/([^/]+(?:\/[^/]+)*)?\/([^./]+)\.(java|kt)$/);
        return {
            pkg: m[1].replace(/\/+/g, '.'),
            type: m[2],
            qtype: m[1] + '/' + m[2],
        }
    },

    getbreakpoint: function (srcfpn, line) {
        var cls = this._splitsrcfpn(srcfpn);
        var bp = this.breakpoints.bysrcloc[cls.qtype + ':' + line];
        return bp;
    },

    getbreakpoints: function (filterfn) {
        var x = this.breakpoints.all.reduce(function (x, bp) {
            if (x.filterfn(bp))
                x.res.push(bp);
            return x;
        }, { filterfn: filterfn, res: [] });
        return x.res;
    },

    getallbreakpoints: function () {
        return this.breakpoints.all.slice();
    },

    setbreakpoint: function (srcfpn, line, conditions) {
        var cls = this._splitsrcfpn(srcfpn);
        var bid = cls.qtype + ':' + line;
        var newbp = this.breakpoints.bysrcloc[bid];
        if (newbp) return $.Deferred().resolveWith(this, [newbp]);
        newbp = {
            id: bid,
            srcfpn: srcfpn,
            qtype: cls.qtype,
            pkg: cls.pkg,
            type: cls.type,
            linenum: line,
            conditions: Object.assign({},conditions),
            sigpattern: new RegExp('^L' + cls.qtype + '([$][$a-zA-Z0-9_]+)?;$'),
            state: 'set', // set,notloaded,enabled,removed
            hitcount: 0,    // number of times this bp was hit during execution
            stopcount: 0.   // number of times this bp caused a break into the debugger
        };
        this.breakpoints.all.push(newbp);
        this.breakpoints.bysrcloc[bid] = newbp;

        // what happens next depends upon what state we are in
        switch (this.status()) {
            case 'connected':
                newbp.state = 'notloaded';
                // try and load the class - if the runtime hasn't loaded it yet, this will just return an empty classes object
                return this._loadclzinfo('L'+newbp.qtype+';')
                    .then(classes => {
                        var bploc = this._findbplocation(classes, newbp);
                        if (!bploc) {
                            // the required location may be inside a nested class (anonymous or named)
                            // Since Android doesn't support the NestedTypes JDWP call (ffs), all we can do here
                            // is look for existing (cached) loaded types matching inner type signatures
                            for (var sig in this.session.classes) {
                                if (newbp.sigpattern.test(sig))
                                    classes[sig] = this.session.classes[sig];
                            }
                            // try again
                            bploc = this._findbplocation(classes, newbp);
                        }
                        if (!bploc) {
                            // we couldn't identify a matching location - either the class is not yet loaded or the
                            // location doesn't correspond to any code. In case it's the former, make sure we are notified
                            // when classes in this package are loaded
                            return this._ensureClassPrepareForPackage(newbp.pkg);
                        }
                        // we found a matching location - set the breakpoint event
                        return this._setupbreakpointsevent([bploc]);
                    })
                    .then(() => newbp)
            case 'connecting':
            case 'disconnected':
            default:
                newbp.state = 'set';
                break;
        }

        return $.Deferred().resolveWith(this, [newbp]);
    },

    clearbreakpoint: function (srcfpn, line) {
        var cls = this._splitsrcfpn(srcfpn);
        var bp = this.breakpoints.bysrcloc[cls.qtype + ':' + line];
        if (!bp) return null;
        return this._clearbreakpoints([bp])[0];
    },

    clearbreakpoints: function (bps) {
        if (typeof (bps) === 'function') {
            // argument is a filter function
            return this.clearbreakpoints(this.getbreakpoints(bps));
        }
        // sanitise first to remove duplicates, non-existants, nulls, etc
        var bpstoclear = [];
        var bpkeys = {};
        (bps || []).forEach(function (bp) {
            if (!bp) return;
            if (this.breakpoints.all.indexOf(bp) < 0) return;
            var bpkey = bp.cls + ':' + bp.linenum;
            if (bpkeys[bpkey]) return;
            bpkeys[bpkey] = 1;
            bpstoclear.push(bp);
        }, this);
        return this._clearbreakpoints(bpstoclear);
    },

    _clearbreakpoints: function (bpstoclear) {
        if (!bpstoclear || !bpstoclear.length) return [];
        bpstoclear.forEach(function (bp) {
            delete this.breakpoints.bysrcloc[bp.qtype + ':' + bp.linenum];
            this.breakpoints.all.splice(this.breakpoints.all.indexOf(bp), 1);
        }, this);

        switch (this.status()) {
            case 'connected':
                var bpcleareddefs = [{ dbgr: this, bpstoclear: bpstoclear }];
                for (var cmlkey in this.breakpoints.enabled) {
                    var enabledbp = this.breakpoints.enabled[cmlkey].bp;
                    if (bpstoclear.indexOf(enabledbp) >= 0) {
                        bpcleareddefs.push(this._clearbreakpointsevent([cmlkey], enabledbp));
                    }
                }
                $.when.apply($, bpcleareddefs)
                    .then(function (x) {
                        x.dbgr._changebpstate(x.bpstoclear, 'removed');
                    });
                break;
            case 'connecting':
            case 'disconnected':
            default:
                this._changebpstate(bpstoclear, 'removed');
                break;
        }

        return bpstoclear;
    },

    getframes: function (threadid, extra) {
        return this.session.adbclient.jdwp_command({
            ths: this,
            extra: extra,
            cmd: this.JDWP.Commands.Frames(threadid),
        }).then(function (frames, extra) {
            var deferreds = [{ dbgr: this, frames: frames, threadid: threadid, extra: extra }];
            for (var i = 0; i < frames.length; i++) {
                deferreds.push(this._findmethodasync(this.session.classes, frames[i].location));
            }
            return $.when.apply($, deferreds)
                .then(function (x) {
                    for (var i = 0; i < x.frames.length; i++) {
                        x.frames[i].method = arguments[i + 1][0];
                        x.frames[i].threadid = x.threadid;
                    }
                    return $.Deferred().resolveWith(x.dbgr, [x.frames, x.extra]);
                });
        })
    },

    getlocals: function (threadid, frame, extra) {
        var method = this._findmethod(this.session.classes, frame.location.cid, frame.location.mid);
        if (!method)
            return $.Deferred().resolveWith(this);

        return this._ensuremethodvars(method)
            .then(function (method) {

                function withincodebounds(low, length, idx) {
                    var i = parseInt(low, 16), j = parseInt(idx, 16);
                    return (j >= i) && (j < (i + length));
                }

                var slots = [];
                var validslots = [];
                var tags = { '[': 76, B: 66, C: 67, L: 76, F: 70, D: 68, I: 73, J: 74, S: 83, V: 86, Z: 90 };
                for (var i = 0, k = method.vartable.vars; i < k.length; i++) {
                    var tag = tags[k[i].type.signature[0]];
                    if (!tag) continue;
                    var p = {
                        slot: k[i].slot,
                        tag: tag,
                        valid: withincodebounds(k[i].codeidx, k[i].length, frame.location.idx)
                    };
                    slots.push(p);
                    if (p.valid) validslots.push(p);
                }

                var x = { method: method, extra: extra, slots: slots };

                if (!validslots.length) {
                    return $.Deferred().resolveWith(this, [[], x]);
                }

                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetStackValues(threadid, frame.frameid, validslots),
                });
            })
            .then(function (values, x) {
                var sv2 = [];
                for (var i = 0; i < x.slots.length; i++) {
                    sv2.push(x.slots[i].valid ? values.shift() : null);
                }
                return this._mapvalues(
                    'local',
                    x.method.vartable.vars,
                    sv2,
                    { frame: frame, slotinfo: null },
                    x
                );
            })
            .then(function (res, x) {
                for (var i = 0; i < res.length; i++)
                    res[i].data.slotinfo = x.slots[i];
                return $.Deferred().resolveWith(this, [res, x.extra]);
            });
    },

    setlocalvalue: function (localvar, data, extra) {
        return this.ensureconnected({ localvar: localvar, data: data, extra: extra })
            .then(function (x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.SetStackValue(x.localvar.data.frame.threadid, x.localvar.data.frame.frameid, x.localvar.data.slotinfo.slot, x.data),
                });
            })
            .then(function (success, x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetStackValues(x.localvar.data.frame.threadid, x.localvar.data.frame.frameid, [x.localvar.data.slotinfo]),
                });
            })
            .then(function (stackvalues, x) {
                return this._mapvalues(
                    'local',
                    [x.localvar],
                    stackvalues,
                    x.localvar.data,
                    x
                );
            })
            .then(function (res, x) {
                return $.Deferred().resolveWith(this, [res[0], x.extra]);
            });
    },

    getsupertype: function (local, extra) {
        if (local.type.signature==='Ljava/lang/Object;')
            return $.Deferred().rejectWith(this,[new Error('java.lang.Object has no super type')]);
        return this.gettypedebuginfo(local.type.signature, { local: local, extra: extra })
            .then(function (dbgtype, x) {
                return this._ensuresuper(dbgtype[x.local.type.signature])
            })
            .then(function (typeinfo) {
                return $.Deferred().resolveWith(this, [typeinfo.super, extra]);
            });
    },

    getsuperinstance: function (local, extra) {
        return this.getsupertype(local, {local,extra})
            .then(function (supertypeinfo, x) {
                var castobj = Object.assign({}, x.local);
                castobj.type = supertypeinfo;
                return $.Deferred().resolveWith(this, [castobj, x.extra]);
            });
    },

    createstring: function (string, extra) {
        return this.ensureconnected({ string: string, extra: extra })
            .then(function (x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.CreateStringObject(string),
                });
            })
            .then(function (strobjref, x) {
                var keys = [{ name: '', type: this.JDWP.signaturetotype('Ljava/lang/String;') }];
                return this._mapvalues('literal', keys, [strobjref], null, x);
            })
            .then(function (vars, x) {
                return $.Deferred().resolveWith(this, [vars[0], x.extra]);
            });
    },

    setstringvalue: function (variable, string, extra) {
        return this.createstring(string, { variable: variable, extra: extra })
            .then(function (string_variable, x) {
                var value = {
                    value: string_variable.value,
                    valuetype: 'oref',
                };
                return this.setvalue(x.variable, value, x.extra);
            })
    },

    setvalue: function (variable, data, extra) {
        if (data.stringliteral) {
            return this.setstringvalue(variable, data.value, extra);
        }
        switch (variable.vtype) {
            case 'field': return this.setfieldvalue(variable, data, extra);
            case 'local': return this.setlocalvalue(variable, data, extra);
            case 'arrelem':
                return this.setarrayvalues(variable.data.arrobj, parseInt(variable.name), 1, data, extra)
                    .then(function (res, extra) {
                        // setarrayvalues returns an array of updated elements - just return the one
                        return $.Deferred().resolveWith(this, [res[0], extra]);
                    });
        }
    },

    setfieldvalue: function (fieldvar, data, extra) {
        return this.ensureconnected({ fieldvar: fieldvar, data: data, extra: extra })
            .then(function (x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.SetFieldValue(x.fieldvar.data.objvar.value, x.fieldvar.data.field, x.data),
                });
            })
            .then(function (success, x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetFieldValues(x.fieldvar.data.objvar.value, [x.fieldvar.data.field]),
                });
            })
            .then(function (fieldvalues, x) {
                return this._mapvalues('field', [x.fieldvar.data.field], fieldvalues, x.fieldvar.data, x);
            })
            .then(function (data, x) {
                return $.Deferred().resolveWith(this, [data[0], x.extra]);
            });
    },

    getfieldvalues: function (objvar, extra) {
        return this.gettypedebuginfo(objvar.type.signature, { objvar: objvar, extra: extra })
            .then(function (dbgtype, x) {
                return this._ensurefields(dbgtype[x.objvar.type.signature], x);
            })
            .then(function (typeinfo, x) {
                x.typeinfo = typeinfo;
                // the Android runtime now pointlessly barfs into logcat if an instance value is used
                // to retrieve a static field. So, we now split into two calls...
                x.splitfields = typeinfo.fields.reduce((z,f) => {
                    if (f.modbits & 8) z.static.push(f); else z.instance.push(f);
                    return z;
                }, {instance:[],static:[]});
                // if there are no instance fields, just resolve with an empty array
                if (!x.splitfields.instance.length)
                    return $.Deferred().resolveWith(this,[[], x]);
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetFieldValues(x.objvar.value, x.splitfields.instance),
                });
            })
            .then(function (instance_fieldvalues, x) {
                x.instance_fieldvalues = instance_fieldvalues;
                // and now the statics (with a type reference)
                if (!x.splitfields.static.length)
                    return $.Deferred().resolveWith(this,[[], x]);
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetStaticFieldValues(x.splitfields.static[0].typeid, x.splitfields.static),
                });
            })
            .then(function (static_fieldvalues, x) {
                x.static_fieldvalues = static_fieldvalues;
                // make sure the fields and values match up...
                var fields = x.splitfields.instance.concat(x.splitfields.static);
                var values = x.instance_fieldvalues.concat(x.static_fieldvalues);
                return this._mapvalues('field', fields, values, { objvar: x.objvar }, x);
            })
            .then(function (res, x) {
                for (var i = 0; i < res.length; i++) {
                    res[i].data.field = x.typeinfo.fields[i];
                }
                return $.Deferred().resolveWith(this, [res, x.extra]);
            });
    },

    getFieldValue: function(objvar, fieldname, includeInherited, extra) {
        const findfield = x => {
            return this.getfieldvalues(x.objvar, x)
                .then((fields, x) => {
                    var field = fields.find(f => f.name === x.fieldname);
                    if (field) return $.Deferred().resolveWith(this,[field,x.extra]);
                    if (!x.includeInherited || x.objvar.type.signature==='Ljava/lang/Object;') {
                        var fqtname = [x.reqtype.package,x.reqtype.typename].join('.');
                        return $.Deferred().rejectWith(this,[new Error(`No such field '${x.fieldname}' in type ${fqtname}`), x.extra]);
                    }
                    // search supertype
                    return this.getsuperinstance(x.objvar, x)
                        .then((superobjvar,x) => {
                            x.objvar = superobjvar;
                            return x.findfield(x);
                        });
                });
        }
        return findfield({findfield, objvar, fieldname, includeInherited, extra, reqtype:objvar.type});
    },

    getExceptionLocal: function (ex_ref_value, extra) {
        var x = {
            ex_ref_value: ex_ref_value,
            extra: extra
        };
        return this.session.adbclient.jdwp_command({
                ths: this,
                extra: x,
                cmd: this.JDWP.Commands.GetObjectType(ex_ref_value),
            })
            .then((typeref, x) => this.session.adbclient.jdwp_command({
                ths: this,
                extra: x,
                cmd: this.JDWP.Commands.signature(typeref)
            }))
            .then((type, x) => {
                x.type = type;
                return this.gettypedebuginfo(type.signature, x)
            })
            .then((dbgtype, x) => {
                return this._ensurefields(dbgtype[x.type.signature], x)
            })
            .then((typeinfo, x) => {
                return this._mapvalues('exception', [{ name: '{ex}', type: x.type }], [x.ex_ref_value], {}, x);
            })
            .then((res, x) => {
                return $.Deferred().resolveWith(this, [res[0], x.extra])
            });
    },

    invokeMethod: function (objectid, threadid, type_signature, method_name, method_sig, args, extra) {
        var x = { 
            objectid, threadid, type_signature, method_name, method_sig, args, extra,
            return_type_signature: method_sig.match(/\)(.*)/)[1],
            def: $.Deferred()
        };
        // we must wait until any previous invokes on the same thread have completed
        var invokes = this.session.invokes[threadid] = (this.session.invokes[threadid] || []);
        if (invokes.push(x) === 1) 
            this._doInvokeMethod(x);
        return x.def;
    },

    _doInvokeMethod: function (x) {
        this.gettypedebuginfo(x.return_type_signature)
            .then(dbgtypes => {
                x.return_type = dbgtypes[x.return_type_signature].type;
                return this.gettypedebuginfo(x.type_signature);
            })
            .then(dbgtype => this._ensuremethods(dbgtype[x.type_signature]))
            .then(typeinfo => {
                // resolving the methods only resolves the non-inherited methods
                // if we can't find a matching method, we need to search the super types
                var o = {
                    dbgr:this,
                    def:$.Deferred(),
                    x: x,
                    find_method(typeinfo) {
                        for (var mid in typeinfo.methods) {
                            var m = typeinfo.methods[mid];
                            if ((m.name === this.x.method_name) && ((m.genericsig||m.sig) === this.x.method_sig)) {
                                this.def.resolveWith(this, [typeinfo, m, this.x]);
                                return;
                            }
                        }
                        // search the supertype
                        if (typeinfo.type.signature==='Ljava/lang/Object;') {
                            this.def.rejectWith(this, [new Error('No such method: ' + this.x.method_name + ' ' + this.x.method_sig)]);
                            return;
                        }
                        
                        this.dbgr._ensuresuper(typeinfo)
                            .then(typeinfo => {
                                return this.dbgr.gettypedebuginfo(typeinfo.super.signature, typeinfo.super.signature)
                            })
                            .then((dbgtype, sig) => {
                                return this.dbgr._ensuremethods(dbgtype[sig])
                            })
                            .then(typeinfo => {
                                this.find_method(typeinfo)
                            });
                    }
                }
                o.find_method(typeinfo);
                return o.def;
            })
            .then((typeinfo, method, x) => {
                x.typeinfo = typeinfo;
                x.method = method;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.InvokeMethod(x.objectid, x.threadid, x.typeinfo.info.typeid, x.method.methodid, x.args),
                })
            })
            .then((res, x) => {
                // res = {return_value, exception}
                if (/^0+$/.test(res.exception))
                    return this._mapvalues('return', [{ name:'{return}', type:x.return_type }], [res.return_value], {}, x);
                // todo - handle reutrn exceptions
            })
            .then((res, x) => {
                x.def.resolveWith(this, [res[0], x.extra]);
            })
            .always(function(invokes) {
                invokes.shift();
                if (invokes.length)
                    this._doInvokeMethod(invokes[0]);
            }.bind(this,this.session.invokes[x.threadid]));
    },

    invokeToString(objectid, threadid, type_signature, extra) {
        return this.invokeMethod(objectid, threadid, type_signature || 'Ljava/lang/Object;', 'toString', '()Ljava/lang/String;', [], extra);
    },

    findNamedMethods(type_signature, name, method_signature) {
        var x = { type_signature, name, method_signature }
        const ismatch = function(x, y) {
            if (!x || (x === y)) return true;
            return (x instanceof RegExp) && x.test(y);
        }
        return this.gettypedebuginfo(x.type_signature)
            .then(dbgtype => this._ensuremethods(dbgtype[x.type_signature]))
            .then(typeinfo => ({
                // resolving the methods only resolves the non-inherited methods
                // if we can't find a matching method, we need to search the super types
                dbgr: this,
                def: $.Deferred(),
                matches:[],
                find_methods(typeinfo) {
                    for (var mid in typeinfo.methods) {
                        var m = typeinfo.methods[mid];
                        // does the name match
                        if (!ismatch(x.name, m.name)) continue;
                        // does the signature match
                        if (!ismatch(x.method_signature, m.genericsig || m.sig)) continue;
                        // add it to the results
                        this.matches.push(m);
                    }
                    // search the supertype
                    if (typeinfo.type.signature === 'Ljava/lang/Object;') {
                        this.def.resolveWith(this.dbgr, [this.matches]);
                        return this;
                    }
                    this.dbgr._ensuresuper(typeinfo)
                        .then(typeinfo => {
                            return this.dbgr.gettypedebuginfo(typeinfo.super.signature, typeinfo.super.signature)
                        })
                        .then((dbgtype, sig) => {
                            return this.dbgr._ensuremethods(dbgtype[sig])
                        })
                        .then(typeinfo => {
                            this.find_methods(typeinfo)
                        });
                    return this;
                }
            }).find_methods(typeinfo).def)
    },

    getstringchars: function (stringref, extra) {
        return this.session.adbclient.jdwp_command({
            ths: this,
            extra: extra,
            cmd: this.JDWP.Commands.GetStringValue(stringref),
        });
    },

    _getstringlen: function (stringref, extra) {
        return this.gettypedebuginfo('Ljava/lang/String;', { stringref: stringref, extra: extra })
            .then(function (dbgtype, x) {
                return this._ensurefields(dbgtype['Ljava/lang/String;'], x);
            })
            .then(function (typeinfo, x) {
                var countfields = typeinfo.fields.filter(f => f.name === 'count');
                if (!countfields.length) return -1;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetFieldValues(x.stringref, countfields),
                });
            })
            .then(function (countfields, x) {
                var len = (countfields && countfields.length === 1) ? countfields[0] : -1;
                return $.Deferred().resolveWith(this, [len, x.extra]);
            });
    },

    getarrayvalues: function (local, start, count, extra) {
        return this.gettypedebuginfo(local.type.elementtype.signature, { local: local, start: start, count: count, extra: extra })
            .then(function (dbgtype, x) {
                x.type = dbgtype[x.local.type.elementtype.signature].type;
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetArrayValues(x.local.value, x.start, x.count),
                });
            })
            .then(function (values, x) {
                // generate some dummy keys to map against
                var keys = [];
                for (var i = 0; i < x.count; i++) {
                    keys.push({ name: '' + (x.start + i), type: x.type });
                }
                return this._mapvalues('arrelem', keys, values, { arrobj: x.local }, x.extra);
            });
    },

    setarrayvalues: function (arrvar, start, count, data, extra) {
        return this.ensureconnected({ arrvar: arrvar, start: start, count: count, data: data, extra: extra })
            .then(function (x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.SetArrayElements(x.arrvar.value, x.start, x.count, x.data),
                });
            })
            .then(function (success, x) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: x,
                    cmd: this.JDWP.Commands.GetArrayValues(x.arrvar.value, x.start, x.count),
                });
            })
            .then(function (values, x) {
                // generate some dummy keys to map against
                var keys = [];
                for (var i = 0; i < count; i++) {
                    keys.push({ name: '' + (x.start + i), type: x.arrvar.type.elementtype });
                }
                return this._mapvalues('arrelem', keys, values, { arrobj: x.arrvar }, x.extra);
            });
    },

    _mapvalues: function (vtype, keys, values, data, extra) {
        var res = [];
        var arrayfields = [];
        var stringfields = [];

        if (values && Array.isArray(values)) {
            var v = values.slice(0), i = 0;
            while (v.length) {
                var info = {
                    vtype: vtype,
                    name: keys[i].name,
                    value: v.shift(),
                    type: keys[i].type,
                    hasnullvalue: false,
                    valid: true,
                    data: Object.assign({}, data),
                };
                info.hasnullvalue = /^0+$/.test(info.value);
                info.valid = info.value !== null;
                res.push(info);
                if (keys[i].type.arraydims)
                    arrayfields.push(info);
                else if (keys[i].type.signature === 'Ljava/lang/String;')
                    stringfields.push(info);
                else if (keys[i].type.signature === 'C')
                    info.char = info.valid ? String.fromCodePoint(info.value) : '';
                i++;
            }
        }
        var defs = [{ dbgr: this, res: res, extra: extra }];
        // for those fields that are (non-null) arrays, retrieve the length
        for (var i in arrayfields) {
            if (arrayfields[i].hasnullvalue || !arrayfields[i].valid) continue;
            var def = this.session.adbclient.jdwp_command({
                ths: this,
                extra: arrayfields[i],
                cmd: this.JDWP.Commands.GetArrayLength(arrayfields[i].value),
            })
                .then(function (arrlen, arrfield) {
                    arrfield.arraylen = arrlen;
                });
            defs.push(def);
        }
        // for those fields that are strings, retrieve the text
        for (var i in stringfields) {
            if (stringfields[i].hasnullvalue || !stringfields[i].valid) continue;
            var def = this._getstringlen(stringfields[i].value, stringfields[i])
                .then(function (len, strfield) {
                    if (len > 10000)
                        return $.Deferred().resolveWith(this, [len, strfield]);
                    // retrieve the actual chars
                    return this.getstringchars(strfield.value, strfield);
                })
                .then(function (str, strfield) {
                    if (typeof (str) === 'number') {
                        strfield.string = '{string exceeds maximum display length}';
                        strfield.biglen = str;
                    } else {
                        strfield.string = str;
                    }
                });
            defs.push(def);
        }

        return $.when.apply($, defs)
            .then(function (x) {
                return $.Deferred().resolveWith(x.dbgr, [x.res, x.extra]);
            });
    },

    gettypedebuginfo: function (signature, extra) {

        var info = {
            signature: signature,
            classes: {},
            ci: { type: this.JDWP.signaturetotype(signature), },
            extra: extra,
            deferred: $.Deferred(),
        };

        if (this.session) {
            // see if we've already retrieved the type for this session
            var cached = this.session.classes[signature];
            if (cached) {
                // are we still retrieving it...
                if (cached.promise) {
                    return cached.promise();
                }
                // return the cached entry
                var res = {}; res[signature] = cached;
                return $.Deferred().resolveWith(this, [res, extra]);
            }
            // while we're retrieving it, set a deferred in it's place
            this.session.classes[signature] = info.deferred;
        }

        this.ensureconnected(info)
            .then(function (info) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: info,
                    cmd: this.JDWP.Commands.classinfo(info.ci),
                });
            })
            .then(function (classinfoarr, info) {
                if (!classinfoarr || !classinfoarr.length) {
                    if (this.session)
                        delete this.session.classes[info.signature];
                    return info.deferred.resolveWith(this, [{}, info.extra]);
                }
                info.ci.info = classinfoarr[0];
                info.ci.name = info.ci.type.typename;
                info.classes[info.ci.type.signature] = info.ci;

                // querying the source file for array or primitive types causes the app to crash
                return (info.ci.type.signature[0] !== 'L'
                    ? $.Deferred().resolveWith(this, [[null], info])
                    : this.session.adbclient.jdwp_command({
                        ths: this,
                        extra: info,
                        cmd: this.JDWP.Commands.sourcefile(info.ci),
                    }))
                    .then(function (srcinfoarr, info) {
                        info.ci.src = srcinfoarr[0];
                        if (this.session) {
                            Object.assign(this.session.classes, info.classes);
                        }
                        return info.deferred.resolveWith(this, [info.classes, info.extra]);	// done
                    });
            });

        return info.deferred;
    },

    _ensuresuper: function (typeinfo) {
        if (typeinfo.super || typeinfo.super === null) {
            if (typeinfo.super && typeinfo.super.promise)
                return typeinfo.super.promise();
            return $.Deferred().resolveWith(this, [typeinfo]);
        }
        if (typeinfo.info.reftype.string !== 'class' || typeinfo.type.signature[0] !== 'L' || typeinfo.type.signature === 'Ljava/lang/Object;') {
            if (typeinfo.info.reftype.string !== 'array') {
                typeinfo.super = null;
                return $.Deferred().resolveWith(this, [typeinfo]);
            }
        }

        typeinfo.super = $.Deferred();
        this.session.adbclient.jdwp_command({
            ths: this,
            extra: typeinfo,
            cmd: this.JDWP.Commands.superclass(typeinfo),
        })
            .then(function (superclassref, typeinfo) {
                return this.session.adbclient.jdwp_command({
                    ths: this,
                    extra: typeinfo,
                    cmd: this.JDWP.Commands.signature(superclassref),
                });
            })
            .then(function (supertype, typeinfo) {
                var def = typeinfo.super;
                typeinfo.super = supertype;
                def.resolveWith(this, [typeinfo]);
            });

        return typeinfo.super.promise();
    },

    _ensurefields: function (typeinfo, extra) {
        if (typeinfo.fields) {
            if (typeinfo.fields.promise)
                return typeinfo.fields.promise();
            return $.Deferred().resolveWith(this, [typeinfo, extra]);
        }
        typeinfo.fields = $.Deferred();

        this.session.adbclient.jdwp_command({
            ths: this,
            extra: { typeinfo: typeinfo, extra: extra },
            cmd: this.JDWP.Commands.fieldsWithGeneric(typeinfo),
        })
            .then(function (fields, x) {
                var def = x.typeinfo.fields;
                x.typeinfo.fields = fields;
                def.resolveWith(this, [x.typeinfo, x.extra]);
            });

        return typeinfo.fields.promise();
    },

    _ensuremethods: function (typeinfo) {
        if (typeinfo.methods) {
            if (typeinfo.methods.promise)
                return typeinfo.methods.promise();
            return $.Deferred().resolveWith(this, [typeinfo]);
        }
        typeinfo.methods = $.Deferred();

        this.session.adbclient.jdwp_command({
            ths: this,
            extra: typeinfo,
            cmd: this.JDWP.Commands.methodsWithGeneric(typeinfo),
        })
            .then(function (methods, typeinfo) {
                var def = typeinfo.methods;
                typeinfo.methods = {};
                for (var i in methods) {
                    methods[i].owningclass = typeinfo;
                    typeinfo.methods[methods[i].methodid] = methods[i];
                }
                def.resolveWith(this, [typeinfo]);
            });

        return typeinfo.methods.promise();
    },

    _ensuremethodvars: function (methodinfo) {
        if (methodinfo.vartable) {
            if (methodinfo.vartable.promise)
                return methodinfo.vartable.promise();
            return $.Deferred().resolveWith(this, [methodinfo]);
        }
        methodinfo.vartable = $.Deferred();

        this.session.adbclient.jdwp_command({
            ths: this,
            extra: methodinfo,
            cmd: this.JDWP.Commands.VariableTableWithGeneric(methodinfo.owningclass, methodinfo),
        })
            .then(function (vartable, methodinfo) {
                var def = methodinfo.vartable;
                methodinfo.vartable = vartable;
                def.resolveWith(this, [methodinfo]);
            });

        return methodinfo.vartable.promise();
    },

    _ensuremethodlines: function (methodinfo) {
        if (methodinfo.linetable) {
            if (methodinfo.linetable.promise)
                return methodinfo.linetable.promise();
            return $.Deferred().resolveWith(this, [methodinfo]);
        }
        methodinfo.linetable = $.Deferred();

        this.session.adbclient.jdwp_command({
            ths: this,
            extra: methodinfo,
            cmd: this.JDWP.Commands.lineTable(methodinfo.owningclass, methodinfo),
        })
            .then(function (linetable, methodinfo) {
                // if the request failed, just return a blank table
                if (linetable.errorcode) {
                    linetable = {
                        errorcode: linetable.errorcode,
                        start: '00000000000000000000000000000000',
                        end: '00000000000000000000000000000000',
                        lines:[],
                    }
                }
                // the linetable does not correlate code indexes with line numbers
                // - location searching relies on the table being ordered by code indexes
                linetable.lines.sort(function (a, b) {
                    return (a.linecodeidx === b.linecodeidx) ? 0 : ((a.linecodeidx < b.linecodeidx) ? -1 : +1);
                });
                var def = methodinfo.linetable;
                methodinfo.linetable = linetable;
                def.resolveWith(this, [methodinfo]);
            });

        return methodinfo.linetable.promise();
    },

    _setupclassprepareevent: function (filter, onprepare) {
        var onevent = {
            data: {
                dbgr: this,
                onprepare: onprepare,
            },
            fn: function (e) {
                var x = e.data;
                x.onprepare.apply(x.dbgr, [e.event]);
            }
        };
        var cmd = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.OnClassPrepare(filter, onevent),
        });

        return cmd.promise();
    },

    _clearLastStepRequest: function (threadid, extra) {
        if (!this.session || !this.session.stepids[threadid])
            return $.Deferred().resolveWith(this,[extra]);

        var clearStepCommand = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.ClearStep(this.session.stepids[threadid]),
            extra: extra,
        }).then((decoded, extra) => extra);
        this.session.stepids[threadid] = 0;
        return clearStepCommand;
    },

    _setupstepevent: function (steptype, threadid, extra) {
        var onevent = {
            data: {
                dbgr: this,
            },
            fn: function (e) {
                e.data.dbgr._clearLastStepRequest(e.event.threadid, e)
                    .then(function (e) {
                        var x = e.data;
                        var loc = e.event.location;

                        // search the cached classes for a matching source location
                        x.dbgr._findcmllocation(x.dbgr.session.classes, loc)
                            .then(function (sloc) {
                                var stoppedloc = sloc || { qtype: null, linenum: null };
                                stoppedloc.threadid = e.event.threadid;

                                var eventdata = {
                                    event: e.event,
                                    stoppedlocation: stoppedloc,
                                };
                                x.dbgr.session.stoppedlocation = stoppedloc;
                                x.dbgr._trigger('step', eventdata);
                            });
                    });
            }
        };
        var cmd = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.SetSingleStep(steptype, threadid, onevent),
            extra: extra,
        }).then((res,extra) => {
            // save the step id so we can manually clear it if an exception break occurs
            if (this.session && res && res.id) 
                this.session.stepids[threadid] = res.id;
            return extra;
        });

        return cmd.promise();
    },

    _setupbreakpointsevent: function (locations) {
        var onevent = {
            data: {
                dbgr: this,
            },
            fn: function (e) {
                var x = e.data;
                var loc = e.event.location;
                var cmlkey = loc.cid + ':' + loc.mid + ':' + loc.idx;
                var bp = x.dbgr.breakpoints.enabled[cmlkey].bp;
                var stoppedloc = {
                    qtype: bp.qtype,
                    linenum: bp.linenum,
                    threadid: e.event.threadid
                };
                var eventdata = {
                    event: e.event,
                    stoppedlocation: stoppedloc,
                    bp: x.dbgr.breakpoints.enabled[cmlkey].bp,
                };
                x.dbgr.session.stoppedlocation = stoppedloc;
                // if this was a conditional breakpoint, it will have been automatically cleared
                // - set a new (unconditional) breakpoint in it's place
                if (bp.conditions.hitcount) {
                    bp.hitcount += bp.conditions.hitcount;
                    delete bp.conditions.hitcount;
                    var bploc = x.dbgr.breakpoints.enabled[cmlkey].bploc;
                    x.dbgr.session.adbclient.jdwp_command({
                        cmd: x.dbgr.JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, null, onevent),
                    });
                } else {
                    bp.hitcount++;
                }
                bp.stopcount++;
                x.dbgr._trigger('bphit', eventdata);
            }
        };

        var bparr = [];
        var cmlkeys = [];
        var setbpcmds = [{ dbgr: this, bparr: bparr, cmlkeys: cmlkeys }];
        for (var i in locations) {
            var bploc = locations[i];
            // associate, so we can find it when the bp hits...
            var cmlkey = bploc.c.info.typeid + ':' + bploc.m.methodid + ':' + bploc.l;
            cmlkeys.push(cmlkey);
            this.breakpoints.enabled[cmlkey] = {
                bp: bploc.bp,
                bploc: {c:bploc.c,m:bploc.m,l:bploc.l},
                requestid: null,
            };
            bparr.push(bploc.bp);
            var cmd = this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, bploc.bp.conditions.hitcount, onevent),
            });
            setbpcmds.push(cmd);
        }

        return $.when.apply($, setbpcmds)
            .then(function (x) {
                // save the request ids from the SetBreakpoint commands so we can disable them later
                for (var i = 0; i < x.cmlkeys.length; i++) {
                    x.dbgr.breakpoints.enabled[x.cmlkeys[i]].requestid = arguments[i + 1][0].id;
                }
                x.dbgr._changebpstate(x.bparr, 'enabled');
                return $.Deferred().resolveWith(x.dbgr);
            });
    },

    _clearbreakpointsevent: function (cmlarr, extra) {
        var bparr = [];
        var clearbpcmds = [{ dbgr: this, extra: extra, bparr: bparr }];

        for (var i in cmlarr) {
            var enabled = this.breakpoints.enabled[cmlarr[i]];
            delete this.breakpoints.enabled[cmlarr[i]];
            bparr.push(enabled.bp);
            var cmd = this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ClearBreakpoint(enabled.requestid),
            });
            clearbpcmds.push(cmd);
        }

        return $.when.apply($, clearbpcmds)
            .then(function (x) {
                x.dbgr._changebpstate(x.bparr, 'notloaded');
                return $.Deferred().resolveWith(x.dbgr, [x.extra]);
            });
    },

    _changebpstate: function (bparr, newstate) {
        if (!bparr || !bparr.length || !newstate) return;
        for (var i in bparr) {
            bparr[i].state = newstate;
        }
        this._trigger('bpstatechange', { breakpoints: bparr.slice(), newstate: newstate });
    },

    _initbreakpoints: function () {
        var deferreds = [{ dbgr: this }];
        // reset any current associations
        this.breakpoints.enabled = {};
        // set all the breakpoints to the notloaded state
        this._changebpstate(this.breakpoints.all, 'notloaded');

        // setup class prepare notifications for all the packages associated with breakpoints
        // when each class is prepared, we initialise any breakpoints for it
        var cpdefs = this.breakpoints.all.map(bp => this._ensureClassPrepareForPackage(bp.pkg));
        deferreds = deferreds.concat(cpdefs);

        return $.when.apply($, deferreds).then(function (x) {
            return $.Deferred().resolveWith(x.dbgr);
        });
    },

    _ensureClassPrepareForPackage: function(pkg) {
        var filter = pkg + '.*';
        if (this.session.cpfilters.includes(filter))
            return $.Deferred().resolveWith(this,[]); // already setup

        this.session.cpfilters.push(filter);
        return this._setupclassprepareevent(filter, preppedclass => {
            // if the class prepare events have overlapping packages (mypackage.*, mypackage.another.*), we will get
            // multiple notifications (which duplicates breakpoints, etc)
            if (this.session.preparedclasses.includes(preppedclass.type.signature)) {
                return; // we already know about this
            }
            this.session.preparedclasses.push(preppedclass.type.signature);
            D('Prepared: ' + preppedclass.type.signature);
            var m = preppedclass.type.signature.match(/^L(.*);$/);
            if (!m) {
                // unrecognised type - just resume
                this._resumesilent();
                return;
            }
            this._loadclzinfo(preppedclass.type.signature)
                .then(function (classes) {
                    var bplocs = [];
                    for (var idx in this.breakpoints.all) {
                        var bp = this.breakpoints.all[idx];
                        var bploc = this._findbplocation(classes, bp);
                        if (bploc) {
                            bplocs.push(bploc);
                        }
                    }
                    if (!bplocs.length) return;
                    // set all the breakpoints in one go...
                    return this._setupbreakpointsevent(bplocs);
                })
                .then(function () {
                    // when all the breakpoints for the newly-prepared type have been set...
                    this._resumesilent();
                });
        });
    },

    clearBreakOnExceptions: function(extra) {
        var o = {
            dbgr: this,
            def: $.Deferred(),
            extra: extra,
            next() {
                if (!this.dbgr.exception_ids.length) {
                    return this.def.resolveWith(this.dbgr, [this.extra]); // done
                }
                // clear next pattern
                this.dbgr.session.adbclient.jdwp_command({
                        cmd: this.dbgr.JDWP.Commands.ClearExceptionBreak(this.dbgr.exception_ids.pop())
                    })
                    .then(() => this.next())
                    .fail(e => this.def.rejectWith(this, [e]))
            }
        };
        o.next();
        return o.def;
    },

    setBreakOnExceptions: function(which, extra) {
        var onevent = {
            data: {
                dbgr: this,
            },
            fn: function (e) {
                // if this exception break occurred during a step request, we must manually clear the event
                // or the (device-side) debugger will crash on next step
                this._clearLastStepRequest(e.event.threadid, e).then(e => {
                    this._findcmllocation(this.session.classes, e.event.throwlocation)
                        .then(tloc => {
                            this._findcmllocation(this.session.classes, e.event.catchlocation)
                                .then(cloc => {
                                    var eventdata = {
                                        event: e.event,
                                        throwlocation: Object.assign({ threadid: e.event.threadid }, tloc),
                                        catchlocation: Object.assign({ threadid: e.event.threadid }, cloc),
                                    };
                                    this.session.stoppedlocation = Object.assign({}, eventdata.throwlocation);
                                    this._trigger('exception', eventdata);
                                })
                        })
                });
            }.bind(this)
        };

        var c = false, u = false;
        switch (which) {
            case 'caught': c = true; break;
            case 'uncaught': u = true; break;
            case 'both': c = u = true; break;
            default: throw new Error('Invalid exception option');
        }
        // when setting up the exceptions, we filter by packages containing public classes in the current session
        // - each filter needs a separate call (I think), so we do this as an asynchronous list
        var pkgs = this.session.build.packages;
        var pkgs_to_monitor = c ? Object.keys(pkgs).filter(pkgname => pkgs[pkgname].public_classes.length) : [];
        var o = {
            dbgr: this,
            filters: pkgs_to_monitor.map(pkg=>pkg+'.*'),
            caught: c,
            uncaught: u,
            onevent: onevent,
            cmds:[],
            def: $.Deferred(),
            extra: extra,
            next() {
                var uncaught = false;
                if (!this.filters.length) {
                    if (!this.uncaught) {
                        this.def.resolveWith(this.dbgr, [this.extra]); // done
                        return;
                    }
                    // setup the uncaught exception break - with no filter
                    uncaught = true;
                    this.filters.push(null);
                    this.caught = this.uncaught = false;
                }
                // setup next pattern
                this.dbgr.session.adbclient.jdwp_command({
                        cmd: this.dbgr.JDWP.Commands.SetExceptionBreak(this.filters.shift(), this.caught, uncaught, this.onevent),
                    })
                    .then(x => {
                        this.dbgr.exception_ids.push(x.id);
                        this.next();
                    })
                    .fail(e => this.def.rejectWith(this, [e]))
            }
        };
        o.next();
        return o.def;
    },

    setThreadNotify: function(extra) {
        var onevent = {
            data: {
                dbgr: this,
            },
            fn: function (e) {
                // the thread notifiers don't give any location information
                //this.session.stoppedlocation = ...
                this._trigger('threadchange', {state:e.event.state, threadid:e.event.threadid});
            }.bind(this)
        };

        return this.ensureconnected(extra)
            .then((extra) => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ThreadStartNotify(onevent),
                extra:extra,
            }))
            .then((res,extra) => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ThreadEndNotify(onevent),
                extra:extra,
            }))
            .then((res, extra) => extra);
    },

    _loadclzinfo: function (signature) {
        return this.gettypedebuginfo(signature)
            .then(function (classes) {
                var defs = [{ dbgr: this, classes: classes }];
                for (var clz in classes) {
                    defs.push(this._ensuremethods(classes[clz]));
                }
                return $.when.apply($, defs).then(function (x) {
                    return $.Deferred().resolveWith(x.dbgr, [x.classes]);
                })
            })
            .then(function (classes) {
                var defs = [{ dbgr: this, classes: classes }];
                for (var clz in classes) {
                    for (var m in classes[clz].methods) {
                        defs.push(this._ensuremethodlines(classes[clz].methods[m]));
                    }
                }
                return $.when.apply($, defs).then(function (x) {
                    return $.Deferred().resolveWith(x.dbgr, [x.classes]);
                })
            });
    },

    _findbplocation: function (classes, bp) {
        // search the classes for a method containing the line
        for (var i in classes) {
            if (!bp.sigpattern.test(classes[i].type.signature))
                continue;
            for (var j in classes[i].methods) {
                var lines = classes[i].methods[j].linetable.lines;
                for (var k in lines) {
                    if (lines[k].linenum === bp.linenum) {
                        // match - save the info for the command later
                        var bploc = {
                            c: classes[i], m: classes[i].methods[j], l: lines[k].linecodeidx,
                            bp: bp,
                        };
                        return bploc;
                    }
                }
            }
        }
        return null;
    },

    line_idx_to_source_location: function (method, idx) {
        if (!method || !method.linetable || !method.linetable.lines || !method.linetable.lines.length)
            return null;
        var m = method.owningclass.type.signature.match(/^L([^;$]+)[$a-zA-Z0-9_]*;$/);
        if (!m)
            return null;
        var lines = method.linetable.lines, prevk = 0;
        for (var k in lines) {
            if (lines[k].linecodeidx < idx) {
                prevk = k;
                continue;
            }
            // multi-part expressions can return intermediate idx's
            // - if the idx is not an exact match, use the previous value
            if (lines[k].linecodeidx > idx)
                k = prevk;
            // convert the class signature to a file location
            return {
                qtype: m[1],
                linenum: lines[k].linenum,
                exact: lines[k].linecodeidx === idx,
            };
        }
        // just return the last location in the list
        return {
            qtype: m[1],
            linenum: lines[lines.length-1].linenum,
            exact: false,
        };
    },

    _findcmllocation: function (classes, loc) {
        // search the classes for a method containing the line
        return this._findmethodasync(classes, loc)
            .then(function (method) {
                if (!method)
                    return $.Deferred().resolveWith(this, [null]);
                return this._ensuremethodlines(method)
                    .then(function (method) {
                        var srcloc = this.line_idx_to_source_location(method, loc.idx);
                        return $.Deferred().resolveWith(this, [srcloc]);
                    });
            });
    },

    _findmethodasync: function (classes, location) {
        // some locations are null (which causes the jdwp command to fail)
        if (/^0+$/.test(location.cid)) return $.Deferred().resolveWith(this, [null]);
        var m = this._findmethod(classes, location.cid, location.mid);
        if (m) return $.Deferred().resolveWith(this, [m]);
        // convert the classid to a type signature
        return this.session.adbclient.jdwp_command({
            ths: this,
            extra: { location: location },
            cmd: this.JDWP.Commands.signature(location.cid),
        })
            .then(function (type, x) {
                return this.gettypedebuginfo(type.signature, x);
            })
            .then(function (classes, x) {
                var defs = [{ dbgr: this, classes: classes, x: x }];
                for (var clz in classes) {
                    defs.push(this._ensuremethods(classes[clz]));
                }
                return $.when.apply($, defs).then(function (x) {
                    return $.Deferred().resolveWith(x.dbgr, [x.classes, x.x]);
                })
            })
            .then(function (classes, x) {
                var m = this._findmethod(classes, x.location.cid, x.location.mid);
                return $.Deferred().resolveWith(this, [m]);
            });
    },

    _findmethod: function (classes, classid, methodid) {
        for (var i in classes) {
            if (classes[i]._isdeferred)
                continue;
            if (classes[i].info.typeid !== classid)
                continue;
            for (var j in classes[i].methods) {
                if (classes[i].methods[j].methodid !== methodid)
                    continue;
                return classes[i].methods[j];
            }
        }
        return null;
    },

    _finitbreakpoints: function () {
        this._changebpstate(this.breakpoints.all, 'set');
        this.breakpoints.enabled = {};
    },

};

exports.Debugger = Debugger;
