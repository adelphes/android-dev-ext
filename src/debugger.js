'use strict'
/*
    Debugger: thin wrapper around other classes to manage debug connections
*/
const _JDWP = require('./jdwp')._JDWP;
const { ADBClient } = require('./adbclient');
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
    inuseports: new Set(),
    debuggers: {},
    reserveport: function () {
        // choose a random port to use each time
        for (let i = 0; i < 10000; i++) {
            const portidx = this.portrange.lowest + ((Math.random() * 100) | 0);
            if (this.inuseports.has(portidx)) {
                continue;   // try again
            }
            this.inuseports.add(portidx);
            return portidx;
        }
        throw new Error('Failed to reserve debugger port');
    },
    freeport: function (port) {
        this.inuseports.delete(port);
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
        let k = this.ons[which];
        if (!k || !k.length) return this;
        k = k.slice();
        e = e || {};
        e.dbgr = this;
        for (let i = 0; i < k.length; i++) {
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
            .then(() => {
                return this.getDebuggablePIDs(this.session.deviceid);
            })
            .then((pids) => {
                // choose the last pid in the list
                const pid = pids[pids.length - 1];
                // after connect(), the caller must call resume() to begin
                return this.connect(pid);
            })
    },

    runapp(action, launcherActivity) {
        // older (<3) versions of Android only allow target components to be specified with -n
        const launchcmdparams = ['--activity-brought-to-front', '-a android.intent.action.MAIN', '-c android.intent.category.LAUNCHER', '-n ' + this.session.build.pkgname + '/' + launcherActivity];
        if (action === 'debug') {
            launchcmdparams.splice(0, 0, '-D');
        }
        const x = {
            dbgr: this,
            shell_cmd: {
                command: 'am start ' + launchcmdparams.join(' '),
                untilclosed: true,
            },
            retries: {
                count: 10, pause: 1000,
            },
            deviceid: this.session.deviceid,
        };
        return new Promise((resolve, reject) => {
            tryrunapp(x);
            function tryrunapp(x) {
                const adb = new ADBClient(x.deviceid);
                adb.shell_cmd(x.shell_cmd)
                    .then(function (stdout) {
                        // failures:
                        //  Error: Activity not started...
                        const m = stdout.match(/Error:.*/g);
                        if (m) {
                            if (--x.retries.count) {
                                setTimeout(function (x) {
                                    tryrunapp(x);
                                }, x.retries.pause, x);
                                return;
                            }
                            return reject(new Error(m[0]));
                        }
                        // running the JDWP command so soon after launching hangs, so give it a breather before continuing
                        setTimeout(x => {
                            resolve(x.deviceid);
                        }, 1000, x);
                    })
                    .catch(reject);
            }
        });
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
            invokes: {},        // hashmap<threadid, promise-callbacks>
        }
        return this;
    },

    /* return a list of deviceids available for debugging */
    list_devices: function () {
        return new ADBClient().list_devices();
    },

    getDebuggablePIDs: function (deviceid) {
        return new ADBClient(deviceid).jdwp_list();
    },

    getDebuggableProcesses: function (deviceid) {
        const adbclient = new ADBClient(deviceid);
        const info = {
            debugger: this,
            jdwps: null,
        };
        return info.adbclient.jdwp_list()
            .then(jdwps => {
                if (!jdwps.length)
                    return null;
                info.jdwps = jdwps;
                // retrieve the ps list from the device
                return adbclient.shell_cmd({
                    command: 'ps',
                    untilclosed: true,
                }).then(stdout => {
                    // output should look something like...
                    // USER     PID   PPID  VSIZE  RSS     WCHAN    PC        NAME
                    // u0_a153   32721 1452  1506500 37916 ffffffff 00000000 S com.example.somepkg
                    // but we cope with variations so long as PID and NAME exist
                    const lines = stdout.split(/\r?\n|\r/g);
                    const hdrs = (lines.shift() || '').trim().toUpperCase().split(/\s+/);
                    const pidindex = hdrs.indexOf('PID');
                    const nameindex = hdrs.indexOf('NAME');
                    const result = {
                        deviceid: adbclient.deviceid,
                        name: {},
                        jdwp: {},
                        all: [],
                    };
                    if (pidindex < 0 || nameindex < 0)
                        return [];
                    // scan the list looking for matching pids...
                    for (let i = 0; i < lines.length; i++) {
                        const entries = lines[i].trim().replace(/ [S] /, ' ').split(/\s+/);
                        if (entries.length != hdrs.length) continue;
                        const jdwpidx = info.jdwps.indexOf(entries[pidindex]);
                        if (jdwpidx < 0) continue;
                        // we found a match
                        const entry = {
                            jdwp: entries[pidindex],
                            name: entries[nameindex],
                        };
                        result.all.push(entry);
                        result.name[entry.name] = entry;
                        result.jdwp[entry.jdwp] = entry;
                    }
                    return result;
                })
            });
    },

    /* attach to the debuggable pid
        Quite a lot happens in this - we setup port forwarding, complete the JDWP handshake,
        setup class loader notifications and call anyone waiting for us.
        If anything fails, we call disconnect() to return to a sense of normality.
    */
    connect: function (jdwpid) {
        switch (this.status()) {
            case 'connected':
                // already connected - just resolve
                return Promise.resolve();
            case 'connecting':
                // wait for the connection to complete (or fail)
                return this.connection.connectingpromise;
            default:
                if (!jdwpid)
                    return Promise.reject(new Error('Debugger not connected'));
                break;
        }

        // from this point on, we are in the "connecting" state until the JDWP handshake is complete
        // (and we mark as connected) or we fail and return to the disconnected state
        this.connection = {
            jdwp: jdwpid,
            localport: this.globals.reserveport(),
            portforwarding: false,
            connected: false,
            connectingpromise: null,
        };

        // setup port forwarding
        return this.connection.connectingpromise = new ADBClient(this.session.deviceid).jdwp_forward({
            localport: this.connection.localport,
            jdwp: this.connection.jdwp,
        })
            .then(() => {
                this.connection.portforwarding = true;
                // after this, the client keeps an open connection until
                // jdwp_disconnect() is called
                this.session.adbclient = new ADBClient(this.session.deviceid);
                return this.session.adbclient.jdwp_connect({
                    localport: this.connection.localport,
                    onreply: this._onjdwpmessage.bind(this),
                });
            })
            .then(() => {
                // handshake has completed
                this.connection.connected = true;
                // call suspend first - we shouldn't really need to do this (as the debugger
                // is already suspended and will not resume until we tell it), but if we
                // don't do this, it logs a complaint...
                return this.suspend();
            })
            .then(() => {
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.idsizes(),
                });
            })
            .then((idsizes) => {
                // set the class loader event notifier so we can set breakpoints...
                this.JDWP.setIDSizes(idsizes);
                return this._initbreakpoints();
            })
            .then(() => {
                return new ADBClient(this.session.deviceid).shell_cmd({
                    command: 'getprop ro.build.version.sdk',
                });
            })
            .then((apilevel) => {
                this.session.apilevel = apilevel.trim();
                // at this point, we are ready to go - all the caller needs to do is call resume().
                this._trigger('connected');
            })
            .catch(err => {
                this.connection.err = err;
                // force a return to the disconnected state
                this.disconnect();
                throw err;
            })
    },

    _onjdwpmessage: function (data) {
        // decodereply will resolve the promise associated with
        // any command this reply is in response to.
        const reply = this.JDWP.decodereply(this, data);
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
        return reply;
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

    forcestop: function () {
        return this.forcestopapp(this.session.deviceid, this.session.build.pkgname);
    },

    forcestopapp: function (deviceid, pkgname) {
        return new ADBClient(deviceid).shell_cmd({
            command: 'am force-stop ' + pkgname,
        });
    },

    disconnect: function () {
        // disconnect is called from a variety of failure scenarios
        // so it must be fairly robust in how it undoes stuff
        const current_state = this.status();
        if (!this.connection)
            return Promise.resolve(current_state);

        const info = {
            connection: this.connection,
            current_state: current_state,
        };
        // from here on in, this instance is in the disconnected state
        this.connection = null;

        // reset the breakpoint states
        this._finitbreakpoints();

        this._trigger('disconnect');

        // perform the JDWP disconnect
        info.jdwpdisconnect = info.connection.connected
            ? this.session.adbclient.jdwp_disconnect()
            : Promise.resolve();

        return info.jdwpdisconnect
            .then(() => {
                this.session.adbclient = null;
                // undo the portforwarding
                // todo: replace remove_all with remove_port
                info.pfremove = info.connection.portforwarding
                    ? new ADBClient(this.session.deviceid).forward_remove_all()
                    : null;

                return info.pfremove;
            })
            .then(() => {
                // mark the port as freed
                if (info.connection.portforwarding) {
                    this.globals.freeport(info.connection.localport)
                }
                return this.forcestop();
            }).then(() => {
                this.session = null;
                return info.current_state;
            });
    },

    allthreads: function () {
        return this.ensureconnected()
            .then(() => {
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.allthreads(),
                });
            });
    },

    threadinfos: function (thread_ids) {
        if (!Array.isArray(thread_ids))
            thread_ids = [thread_ids];
        const threadinfos = [];
        let idx = 0;
        const next = () => {
            const thread_id = thread_ids[idx];
            if (typeof (thread_id) === 'undefined')
                return Promise.resolve(threadinfos);
            const info = {
                threadid: thread_id,
                name: '',
                status: null,
            };
            return this.session.adbclient.jdwp_command({ cmd: this.JDWP.Commands.threadname(info.threadid) })
                .then(name => {
                    info.name = name;
                    return this.session.adbclient.jdwp_command({ cmd: this.JDWP.Commands.threadstatus(info.threadid) })
                })
                .then(status => {
                    info.status = status;
                    threadinfos.push(info);
                })
                .catch(() => { })
                .then(() => (idx++ , next()))
        }
        return this.ensureconnected().then(() => next());
    },

    suspend: function () {
        return this.ensureconnected()
            .then(() => {
                this._trigger('suspending');
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.suspend(),
                });
            })
            .then(() => {
                this._trigger('suspended');
            });
    },

    suspendthread: function (threadid) {
        return this.ensureconnected()
            .then(() => {
                this.session.threadsuspends[threadid] = (this.session.threadsuspends[threadid] | 0) + 1;
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.suspendthread(threadid),
                });
            })
    },

    _resume: function (triggers) {
        return this.ensureconnected()
            .then(() => {
                if (triggers) this._trigger('resuming');
                this.session.stoppedlocation = null;
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.resume(),
                });
            })
            .then(() => {
                if (triggers) this._trigger('resumed');
            });
    },

    resume: function () {
        return this._resume(true);
    },

    _resumesilent: function () {
        return this._resume(false);
    },

    resumethread: function (threadid) {
        return this.ensureconnected()
            .then(() => {
                this.session.threadsuspends[threadid] = (this.session.threadsuspends[threadid] | 0) - 1;
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.resumethread(threadid),
                });
            })
    },

    step: function (steptype, threadid) {
        return this.ensureconnected()
            .then(() => {
                this._trigger('stepping');
                return this._setupstepevent(steptype, threadid);
            })
            .then(() => this.resumethread(threadid))
    },

    _splitsrcfpn: function (srcfpn) {
        const m = srcfpn.match(/^\/([^/]+(?:\/[^/]+)*)?\/([^./]+)\.(java|kt)$/);
        return {
            pkg: m[1].replace(/\/+/g, '.'),
            type: m[2],
            qtype: m[1] + '/' + m[2],
        }
    },

    getbreakpoint: function (srcfpn, line) {
        const cls = this._splitsrcfpn(srcfpn);
        const bp = this.breakpoints.bysrcloc[cls.qtype + ':' + line];
        return bp;
    },

    getbreakpoints: function (filterfn) {
        return this.breakpoints.all.filter(filterfn);
    },

    getallbreakpoints: function () {
        return this.breakpoints.all.slice();
    },

    setbreakpoint: function (srcfpn, line, conditions) {
        const cls = this._splitsrcfpn(srcfpn);
        const bid = cls.qtype + ':' + line;
        let newbp = this.breakpoints.bysrcloc[bid];
        if (newbp) {
            return Promise.resolve(newbp);
        }
        newbp = {
            id: bid,
            srcfpn: srcfpn,
            qtype: cls.qtype,
            pkg: cls.pkg,
            type: cls.type,
            linenum: line,
            conditions: Object.assign({}, conditions),
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
                return this._loadclzinfo('L' + newbp.qtype + ';')
                    .then(classes => {
                        let bploc = this._findbplocation(classes, newbp);
                        if (!bploc) {
                            // the required location may be inside a nested class (anonymous or named)
                            // Since Android doesn't support the NestedTypes JDWP call (ffs), all we can do here
                            // is look for existing (cached) loaded types matching inner type signatures
                            for (let sig in this.session.classes) {
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

        return Promise.resolve(newbp);
    },

    clearbreakpoint: function (srcfpn, line) {
        const cls = this._splitsrcfpn(srcfpn);
        const bp = this.breakpoints.bysrcloc[cls.qtype + ':' + line];
        if (!bp) return null;
        return this._clearbreakpoints([bp])[0];
    },

    clearbreakpoints: function (bps) {
        if (typeof (bps) === 'function') {
            // argument is a filter function
            return this.clearbreakpoints(this.getbreakpoints(bps));
        }
        // sanitise first to remove duplicates, non-existants, nulls, etc
        const bpstoclear = [];
        const bpkeys = {};
        (bps || []).forEach(bp => {
            if (!bp) return;
            if (this.breakpoints.all.indexOf(bp) < 0) return;
            const bpkey = `${bp.cls}:${bp.linenum}`;
            if (bpkeys[bpkey]) return;
            bpkeys[bpkey] = 1;
            bpstoclear.push(bp);
        });
        return this._clearbreakpoints(bpstoclear);
    },

    _clearbreakpoints: function (bpstoclear) {
        if (!bpstoclear || !bpstoclear.length) return [];
        bpstoclear.forEach(bp => {
            delete this.breakpoints.bysrcloc[bp.qtype + ':' + bp.linenum];
            this.breakpoints.all.splice(this.breakpoints.all.indexOf(bp), 1);
        });

        switch (this.status()) {
            case 'connected':
                const bp_clear_promises = [];
                for (let cmlkey in this.breakpoints.enabled) {
                    const enabledbp = this.breakpoints.enabled[cmlkey].bp;
                    if (bpstoclear.indexOf(enabledbp) >= 0) {
                        bp_clear_promises.push(this._clearbreakpointsevent([cmlkey], enabledbp));
                    }
                }
                Promise.all(bp_clear_promises).then(() => this._changebpstate(bpstoclear, 'removed'));
                break;
            case 'connecting':
            case 'disconnected':
            default:
                this._changebpstate(bpstoclear, 'removed');
                break;
        }

        return bpstoclear;
    },

    getframes: function (threadid) {
        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.Frames(threadid),
        }).then(frames => {
            const method_promises = frames.map(frame => this._findmethodasync(this.session.classes, frame.location));
            return Promise.all(method_promises)
                .then(methods => {
                    for (let i = 0; i < frames.length; i++) {
                        frames[i].method = methods[i];
                        frames[i].threadid = threadid;
                    }
                    return frames;
                });
        })
    },

    getlocals: function (threadid, frame) {
        const method = this._findmethod(this.session.classes, frame.location.cid, frame.location.mid);
        if (!method) {
            return Promise.resolve([]);
        }
        const slots = [];
        return this._ensuremethodvars(method)
            .then(method => {

                function withincodebounds(low, length, idx) {
                    const i = parseInt(low, 16);
                    const j = parseInt(idx, 16);
                    return (j >= i) && (j < (i + length));
                }

                const validslots = [];
                const tags = { '[': 76, B: 66, C: 67, L: 76, F: 70, D: 68, I: 73, J: 74, S: 83, V: 86, Z: 90 };
                for (let i = 0, k = method.vartable.vars; i < k.length; i++) {
                    const tag = tags[k[i].type.signature[0]];
                    if (!tag) continue;
                    const p = {
                        slot: k[i].slot,
                        tag: tag,
                        valid: withincodebounds(k[i].codeidx, k[i].length, frame.location.idx)
                    };
                    slots.push(p);
                    if (p.valid) {
                        validslots.push(p);
                    }
                }

                if (!validslots.length) {
                    return Promise.resolve([]);
                }

                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.GetStackValues(threadid, frame.frameid, validslots),
                });
            })
            .then(values => {
                values = values || [];
                const valid_slot_values = slots.map(slot => slot.valid ? values.shift() : null);
                return this._mapvalues(
                    'local',
                    method.vartable.vars,
                    valid_slot_values,
                    { frame: frame, slotinfo: null }
                );
            })
            .then(res => {
                for (let i = 0; i < res.length; i++)
                    res[i].data.slotinfo = slots[i];
                return res;
            });
    },

    setlocalvalue: function (localvar, data) {
        return this.ensureconnected()
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.SetStackValue(localvar.data.frame.threadid, localvar.data.frame.frameid, localvar.data.slotinfo.slot, data),
            }))
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.GetStackValues(localvar.data.frame.threadid, localvar.data.frame.frameid, [localvar.data.slotinfo]),
            }))
            .then(stackvalues => {
                return this._mapvalues(
                    'local',
                    [localvar],
                    stackvalues,
                    localvar.data
                );
            })
            .then(res => res[0]);
    },

    getsupertype: function (local) {
        if (local.type.signature === 'Ljava/lang/Object;')
            throw new Error('java.lang.Object has no super type');

        return this.gettypedebuginfo(local.type.signature)
            .then(dbgtype => this._ensuresuper(dbgtype[local.type.signature]))
            .then(typeinfo => typeinfo.super)
    },

    getsuperinstance: function (local) {
        return this.getsupertype(local)
            .then(supertypeinfo => {
                const castobj = Object.assign({}, local, { type: supertypeinfo });
                return castobj;
            });
    },

    createstring: function (string) {
        return this.ensureconnected()
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.CreateStringObject(string),
            }))
            .then(strobjref => {
                const keys = [{ name: '', type: this.JDWP.signaturetotype('Ljava/lang/String;') }];
                return this._mapvalues('literal', keys, [strobjref], null);
            })
            .then(vars => vars[0])
    },

    setstringvalue: function (variable, string) {
        return this.createstring(string)
            .then(string_variable => {
                const value = {
                    value: string_variable.value,
                    valuetype: 'oref',
                };
                return this.setvalue(variable, value);
            })
    },

    setvalue: function (variable, data) {
        if (data.stringliteral) {
            return this.setstringvalue(variable, data.value);
        }
        switch (variable.vtype) {
            case 'field':
                return this.setfieldvalue(variable, data);
            case 'local':
                return this.setlocalvalue(variable, data);
            case 'arrelem':
                return this.setarrayvalues(variable.data.arrobj, parseInt(variable.name), 1, data)
                    .then(res => res[0]);
        }
    },

    setfieldvalue: function (fieldvar, data) {
        return this.ensureconnected()
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.SetFieldValue(fieldvar.data.objvar.value, fieldvar.data.field, data),
            }))
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.GetFieldValues(fieldvar.data.objvar.value, [fieldvar.data.field]),
            }))
            .then(fieldvalues => this._mapvalues('field', [fieldvar.data.field], fieldvalues, fieldvar.data))
            .then(res => res[0])
    },

    getfieldvalues: function (objvar) {
        return this.gettypedebuginfo(objvar.type.signature)
            .then(dbgtype => this._ensurefields(dbgtype[objvar.type.signature]))
            .then(typeinfo => {
                // the Android runtime now pointlessly barfs into logcat if an instance value is used
                // to retrieve a static field. So, we now split into two calls...
                const splitfields = typeinfo.fields.reduce((z, f) => {
                    if (f.modbits & 8) z.static.push(f); else z.instance.push(f);
                    return z;
                }, { instance: [], static: [] });

                return (
                    splitfields.instance.length
                        ? this.session.adbclient.jdwp_command({
                            cmd: this.JDWP.Commands.GetFieldValues(objvar.value, splitfields.instance),
                        })
                        : Promise.resolve([])
                )
                    .then(instance_fieldvalues => {
                        // and now the statics (with a type reference)
                        return (
                            splitfields.static.length
                                ? this.session.adbclient.jdwp_command({
                                    cmd: this.JDWP.Commands.GetStaticFieldValues(splitfields.static[0].typeid, splitfields.static),
                                })
                                : Promise.resolve([])
                        )
                            .then(static_fieldvalues => {
                                // make sure the fields and values match up...
                                const fields = [...splitfields.instance, ...splitfields.static];
                                const values = [...instance_fieldvalues, ...static_fieldvalues];
                                return this._mapvalues('field', fields, values, { objvar });
                            })
                    })
                    .then(res => {
                        for (let i = 0; i < res.length; i++) {
                            res[i].data.field = typeinfo.fields[i];
                        }
                        return res;
                    });
            })
    },

    getFieldValue: function (instance, fieldname, includeInherited) {
        const fqtname = `${instance.type.package}.${instance.type.typename}`;
        const findfield = instance => {
            return this.getfieldvalues(instance)
                .then(fields => {
                    const field = fields.find(f => f.name === fieldname);
                    if (field) {
                        return field;
                    }
                    if (!includeInherited || instance.type.signature === 'Ljava/lang/Object;') {
                        throw new Error(`No such field '${fieldname}' in type ${fqtname}`);
                    }
                    // search supertype
                    return this.getsuperinstance(instance)
                        .then(superinstance => findfield(superinstance))
                });
        }
        return findfield(instance);
    },

    getExceptionLocal: function (ex_ref_value) {
        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.GetObjectType(ex_ref_value),
        })
            .then(typeref => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.signature(typeref)
            }))
            .then(type =>
                this.gettypedebuginfo(type.signature)
                    .then(dbgtype => this._ensurefields(dbgtype[type.signature]))
                    .then(() => this._mapvalues('exception', [{ name: '{ex}', type }], [ex_ref_value], {}))
                    .then(res => res[0])
            );
    },

    invokeMethod: function (objectid, threadid, type_signature, method_name, method_sig, args) {
        const x = {
            objectid, threadid, type_signature, method_name, method_sig, args,
            return_type_signature: method_sig.match(/\)(.*)/)[1],
            promise: null,
        };
        return new Promise((resolve, reject) => {
            x.promise = { resolve, reject };
            // we must wait until any previous invokes on the same thread have completed
            const invokes = this.session.invokes[threadid] = (this.session.invokes[threadid] || []);
            if (invokes.push(x) === 1)
                this._doInvokeMethod(x);
        });
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
                const find_method = (typeinfo) => {
                    for (let mid in typeinfo.methods) {
                        const method = typeinfo.methods[mid];
                        if ((method.name === x.method_name) && ((method.genericsig || method.sig) === x.method_sig)) {
                            return { typeinfo, method };    // found
                        }
                    }
                    // search the supertype
                    if (typeinfo.type.signature === 'Ljava/lang/Object;') {
                        throw new Error(`No such method: ${this.x.method_name} ${this.x.method_sig}`);
                    }
                    return this._ensuresuper(typeinfo)
                        .then(typeinfo => this.gettypedebuginfo(typeinfo.super.signature))
                        .then(supertype => this._ensuremethods(supertype[typeinfo.super.signature]))
                        .then(supertypeinfo => find_method(supertypeinfo));
                };
                return find_method(typeinfo);
            })
            .then(({ typeinfo, method }) =>
                this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.InvokeMethod(x.objectid, x.threadid, typeinfo.info.typeid, method.methodid, x.args),
                })
            )
            .then(res => {
                // res = {return_value, exception}
                if (/^0+$/.test(res.exception))
                    return this._mapvalues('return', [{ name: '{return}', type: x.return_type }], [res.return_value], {});
                // todo - handle reutrn exceptions
            })
            .then(res => {
                x.promise.resolve(res[0]);
            })
            .catch(err => {
                x.promise.reject(err);
            })
            .then(() => {
                const invokes = this.session.invokes[x.threadid];
                invokes.shift();
                if (invokes.length)
                    this._doInvokeMethod(invokes[0]);
            })
    },

    invokeToString(objectid, threadid, type_signature) {
        return this.invokeMethod(objectid, threadid, type_signature || 'Ljava/lang/Object;', 'toString', '()Ljava/lang/String;', []);
    },

    findNamedMethods(type_signature, name, method_signature) {
        const ismatch = function (x, y) {
            if (!x || (x === y)) return true;
            return (x instanceof RegExp) && x.test(y);
        }
        return this.gettypedebuginfo(type_signature)
            .then(dbgtype => this._ensuremethods(dbgtype[type_signature]))
            .then(typeinfo => {
                // resolving the methods only resolves the non-inherited methods
                // if we can't find a matching method, we need to search the super types
                const find_methods = (typeinfo, matches) => {
                    for (let mid in typeinfo.methods) {
                        const m = typeinfo.methods[mid];
                        // does the name match
                        if (!ismatch(name, m.name)) continue;
                        // does the signature match
                        if (!ismatch(method_signature, m.genericsig || m.sig)) continue;
                        // add it to the results
                        matches.push(m);
                    }
                    // search the supertype
                    if (typeinfo.type.signature === 'Ljava/lang/Object;') {
                        return Promise.resolve(matches);
                    }
                    return this._ensuresuper(typeinfo)
                        .then(typeinfo => {
                            return this.gettypedebuginfo(typeinfo.super.signature)
                                .then(supertypeinfo => this._ensuremethods(supertypeinfo[typeinfo.super.signature]))
                                .then(supertypeinfo => find_methods(supertypeinfo, matches))
                        });
                };
                return find_methods(typeinfo, []);
            });
    },

    getstringchars: function (stringref) {
        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.GetStringValue(stringref),
        });
    },

    _getstringlen: function (stringref) {
        return this.gettypedebuginfo('Ljava/lang/String;')
            .then(dbgtype => {
                return this._ensurefields(dbgtype['Ljava/lang/String;']);
            })
            .then(typeinfo => {
                const countfields = typeinfo.fields.filter(f => f.name === 'count');
                if (!countfields.length) return null;
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.GetFieldValues(stringref, countfields),
                });
            })
            .then(countfields => {
                const len = (countfields && countfields.length === 1) ? countfields[0] : -1;
                return len;
            });
    },

    getarrayvalues: function (local, start, count) {
        let type;
        return this.gettypedebuginfo(local.type.elementtype.signature)
            .then(dbgtype => {
                type = dbgtype[local.type.elementtype.signature].type;
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.GetArrayValues(local.value, start, count),
                });
            })
            .then(values => {
                // generate some dummy keys to map against
                const keys = [];
                for (let i = 0; i < count; i++) {
                    keys.push({
                        name: `${start + i}`,
                        type,
                    });
                }
                return this._mapvalues('arrelem', keys, values, { arrobj: local });
            });
    },

    setarrayvalues: function (arrvar, start, count, data) {
        return this.ensureconnected()
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.SetArrayElements(arrvar.value, start, count, data),
            }))
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.GetArrayValues(arrvar.value, start, count),
            }))
            .then(values => {
                // generate some dummy keys to map against
                const keys = [];
                for (let i = 0; i < count; i++) {
                    keys.push({
                        name: `${start + i}`,
                        type: arrvar.type.elementtype,
                    });
                }
               return this._mapvalues('arrelem', keys, values, { arrobj: arrvar });
            });
    },

    _mapvalues: function (vtype, keys, values, data) {
        const res = [];
        const arrayfields = [];
        const stringfields = [];

        if (values && Array.isArray(values)) {
            const v = values.slice(0);
            let i = 0;
            while (v.length) {
                const info = {
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
        const defs = [];
        // for those fields that are (non-null) arrays, retrieve the length
        arrayfields.forEach(arrayfield => {
            if (arrayfield.hasnullvalue || !arrayfield.valid) {
                return;
            }
            const def = this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.GetArrayLength(arrayfield.value),
            })
                .then(arrlen => arrayfield.arraylen = arrlen);
            defs.push(def);
        });
        // for those fields that are strings, retrieve the text
        stringfields.forEach(stringfield => {
            if (stringfield.hasnullvalue || !stringfield.valid) {
                return;
            }
            const def = this._getstringlen(stringfield.value)
                .then(len => {
                    if (len > 10000)
                        return len;
                    // retrieve the actual chars
                    return this.getstringchars(stringfield.value);
                })
                .then(str => {
                    if (typeof (str) === 'number') {
                        stringfield.string = '{string exceeds maximum display length}';
                        stringfield.biglen = str;
                    } else {
                        stringfield.string = str;
                    }
                });
            defs.push(def);
        });

        return Promise.all(defs).then(() => res);
    },

    gettypedebuginfo: function (signature) {

        const info = {
            signature,
            classes: {},
            ci: {
                type: this.JDWP.signaturetotype(signature),
            },
        };

        if (this.session) {
            // see if we've already retrieved the type for this session
            const cached = this.session.classes[signature];
            if (cached) {
                // are we still retrieving it...
                if (cached instanceof Promise) {
                    return cached;
                }
                // return the cached entry
                const res = {}; res[signature] = cached;
                return Promise.resolve(res);
            }
        }

        const p = this.ensureconnected()
            .then(() => {
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.classinfo(info.ci),
                });
            })
            .then(classinfoarr => {
                if (!classinfoarr || !classinfoarr.length) {
                    if (this.session)
                        delete this.session.classes[info.signature];
                    return Promise.resolve({});
                }
                info.ci.info = classinfoarr[0];
                info.ci.name = info.ci.type.typename;
                info.classes[info.ci.type.signature] = info.ci;

                // querying the source file for array or primitive types causes the app to crash
                return (info.ci.type.signature[0] === 'L'
                    ? this.session.adbclient.jdwp_command({
                        cmd: this.JDWP.Commands.sourcefile(info.ci),
                    })
                    : Promise.resolve([null]))
                    .then(srcinfoarr => {
                        info.ci.src = srcinfoarr[0];
                        if (this.session) {
                            Object.assign(this.session.classes, info.classes);
                        }
                        return info.classes;	// done
                    });
            });

        // while we're retrieving it, set a promise in it's place
        if (this.session) {
            this.session.classes[signature] = p;
        }

        return p;
    },

    _ensuresuper: function (typeinfo) {
        if (typeinfo.super || typeinfo.super === null) {
            if (typeinfo.super && (typeinfo.super instanceof Promise))
                return typeinfo.super;
            return Promise.resolve(typeinfo);
        }
        if (typeinfo.info.reftype.string !== 'class' || typeinfo.type.signature[0] !== 'L' || typeinfo.type.signature === 'Ljava/lang/Object;') {
            if (typeinfo.info.reftype.string !== 'array') {
                typeinfo.super = null;
                return Promise.resolve(typeinfo);
            }
        }

        return typeinfo.super = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.superclass(typeinfo),
        })
            .then(superclassref => {
                return this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.signature(superclassref),
                });
            })
            .then(supertype => {
                typeinfo.super = supertype;
                return typeinfo;
            });
    },

    _ensurefields: function (typeinfo) {
        if (typeinfo.fields) {
            if (typeinfo.fields instanceof Promise)
                return typeinfo.fields;
            return Promise.resolve(typeinfo);
        }

        return typeinfo.fields = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.fieldsWithGeneric(typeinfo),
        })
            .then(fields => {
                typeinfo.fields = fields;
                return typeinfo;
            });
    },

    _ensuremethods: function (typeinfo) {
        if (typeinfo.methods) {
            if (typeinfo.methods instanceof Promise)
                return typeinfo.methods;
            return Promise.resolve(typeinfo);
        }

        return typeinfo.methods = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.methodsWithGeneric(typeinfo),
        })
            .then(methods => {
                typeinfo.methods = {};
                // for (let i in methods) {
                //     methods[i].owningclass = typeinfo;
                //     typeinfo.methods[methods[i].methodid] = methods[i];
                // }
                methods.forEach(method => {
                    method.owningclass = typeinfo;
                    typeinfo.methods[method.methodid] = method;
                });
                return typeinfo;
            });
    },

    _ensuremethodvars: function (methodinfo) {
        if (methodinfo.vartable) {
            if (methodinfo.vartable instanceof Promise)
                return methodinfo.vartable;
            return Promise.resolve(methodinfo);
        }

        return methodinfo.vartable = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.VariableTableWithGeneric(methodinfo.owningclass, methodinfo),
        })
            .then(vartable => {
                methodinfo.vartable = vartable;
                return methodinfo;
            });
    },

    _ensuremethodlines: function (methodinfo) {
        if (methodinfo.linetable) {
            if (methodinfo.linetable instanceof Promise)
                return methodinfo.linetable;
            return Promise.resolve(methodinfo);
        }

        return methodinfo.linetable = this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.lineTable(methodinfo.owningclass, methodinfo),
        })
            .catch(() => {
                // if the request failed, just return a blank table
                return {
                    start: '00000000000000000000000000000000',
                    end: '00000000000000000000000000000000',
                    lines: [],
                };
            })
            .then(linetable => {
                // the linetable does not correlate code indexes with line numbers
                // - location searching relies on the table being ordered by code indexes
                linetable.lines.sort(function (a, b) {
                    return (a.linecodeidx === b.linecodeidx) ? 0 : ((a.linecodeidx < b.linecodeidx) ? -1 : +1);
                });
                methodinfo.linetable = linetable;
                return methodinfo;
            });
    },

    _setupclassprepareevent: function (filter, onprepare) {
        const onevent = {
            data: {
                onprepare,
            },
            fn: (e) => {
                e.data.onprepare(e.event);
            }
        };
        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.OnClassPrepare(filter, onevent),
        });
    },

    _clearLastStepRequest: function (threadid) {
        if (!this.session || !this.session.stepids[threadid])
            return Promise.resolve();

        const stepid = this.session.stepids[threadid];
        this.session.stepids[threadid] = 0;

        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.ClearStep(stepid),
        });
    },

    _setupstepevent: function (steptype, threadid) {
        const onevent = {
            data: {
                dbgr: this,
            },
            fn: (e) => {
                this._clearLastStepRequest(e.event.threadid)
                    .then(() => {
                        // search the cached classes for a matching source location
                        return this._findcmllocation(this.session.classes, e.event.location);
                    })
                    .then(sloc => {
                        const stoppedloc = sloc || { qtype: null, linenum: null };
                        stoppedloc.threadid = e.event.threadid;

                        const eventdata = {
                            event: e.event,
                            stoppedlocation: stoppedloc,
                        };
                        this.session.stoppedlocation = stoppedloc;
                        this._trigger('step', eventdata);
                    });
            }
        };

        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.SetSingleStep(steptype, threadid, onevent),
        }).then(res => {
            // save the step id so we can manually clear it if an exception break occurs
            if (this.session && res && res.id)
                this.session.stepids[threadid] = res.id;
        });
    },

    _setupbreakpointsevent: function (locations) {
        const onevent = {
            data: {
                dbgr: this,
            },
            fn: (e) => {
                const loc = e.event.location;
                const cmlkey = `${loc.cid}:${loc.mid}:${loc.idx}`;
                const bp = this.breakpoints.enabled[cmlkey].bp;
                const stoppedloc = {
                    qtype: bp.qtype,
                    linenum: bp.linenum,
                    threadid: e.event.threadid
                };
                const eventdata = {
                    event: e.event,
                    stoppedlocation: stoppedloc,
                    bp,
                };
                this.session.stoppedlocation = stoppedloc;
                // if this was a conditional breakpoint, it will have been automatically cleared
                // - set a new (unconditional) breakpoint in it's place
                if (bp.conditions.hitcount) {
                    bp.hitcount += bp.conditions.hitcount;
                    delete bp.conditions.hitcount;
                    const bploc = this.breakpoints.enabled[cmlkey].bploc;
                    this.session.adbclient.jdwp_command({
                        cmd: this.JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, null, onevent),
                    });
                } else {
                    bp.hitcount++;
                }
                bp.stopcount++;
                this._trigger('bphit', eventdata);
            }
        };

        const bparr = [];
        const cmlkeys = [];
        const setbpcmds = [];
        for (let i in locations) {
            const bploc = locations[i];
            // associate, so we can find it when the bp hits...
            const cmlkey = `${bploc.c.info.typeid}:${bploc.m.methodid}:${bploc.l}`;
            cmlkeys.push(cmlkey);
            this.breakpoints.enabled[cmlkey] = {
                bp: bploc.bp,
                bploc: { c: bploc.c, m: bploc.m, l: bploc.l },
                requestid: null,
            };
            bparr.push(bploc.bp);
            const set_bp_cmd = this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, bploc.bp.conditions.hitcount, onevent),
            });
            setbpcmds.push(set_bp_cmd);
        }

        return Promise.all(setbpcmds)
            .then((res) => {
                // save the request ids from the SetBreakpoint commands so we can disable them later
                for (let i = 0; i < cmlkeys.length; i++) {
                    this.breakpoints.enabled[cmlkeys[i]].requestid = res[i].id;
                }
                this._changebpstate(bparr, 'enabled');
            });
    },

    _clearbreakpointsevent: function (cmlarr) {
        const bparr = [];
        const clearbpcmds = [];

        for (let i in cmlarr) {
            const enabled = this.breakpoints.enabled[cmlarr[i]];
            delete this.breakpoints.enabled[cmlarr[i]];
            bparr.push(enabled.bp);
            const clear_bp_cmd = this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ClearBreakpoint(enabled.requestid),
            });
            clearbpcmds.push(clear_bp_cmd);
        }

        return Promise.all(clearbpcmds)
            .then(() => {
                this._changebpstate(bparr, 'notloaded');
            });
    },

    _changebpstate: function (bparr, newstate) {
        if (!bparr || !bparr.length || !newstate) {
            return;
        }
        bparr.forEach(bp => bp.state = newstate);
        // for (let i in bparr) {
        //     bparr[i].state = newstate;
        // }
        this._trigger('bpstatechange', {
            breakpoints: bparr.slice(),
            newstate: newstate,
        });
    },

    _initbreakpoints: function () {
        // reset any current associations
        this.breakpoints.enabled = {};
        // set all the breakpoints to the notloaded state
        this._changebpstate(this.breakpoints.all, 'notloaded');

        // setup class prepare notifications for all the packages associated with breakpoints
        // when each class is prepared, we initialise any breakpoints for it
        const class_prepare_promises = this.breakpoints.all.map(bp => this._ensureClassPrepareForPackage(bp.pkg));

        return Promise.all(class_prepare_promises);
    },

    _ensureClassPrepareForPackage: function (pkg) {
        let filter = pkg + '.*';
        if (this.session.cpfilters.includes(filter))
            return Promise.resolve(); // already setup

        this.session.cpfilters.push(filter);
        return this._setupclassprepareevent(filter, preppedclass => {
            // if the class prepare events have overlapping packages (mypackage.*, mypackage.another.*), we will get
            // multiple notifications (which duplicates breakpoints, etc)
            if (this.session.preparedclasses.includes(preppedclass.type.signature)) {
                return; // we already know about this
            }
            this.session.preparedclasses.push(preppedclass.type.signature);
            D('Prepared: ' + preppedclass.type.signature);
            const m = preppedclass.type.signature.match(/^L(.*);$/);
            if (!m) {
                // unrecognised type - just resume
                return this._resumesilent();
            }
            return this._loadclzinfo(preppedclass.type.signature)
                .then((classes) => {
                    const bplocs = [];
                    for (let idx in this.breakpoints.all) {
                        const bp = this.breakpoints.all[idx];
                        const bploc = this._findbplocation(classes, bp);
                        if (bploc) {
                            bplocs.push(bploc);
                        }
                    }
                    if (!bplocs.length) return;
                    // set all the breakpoints in one go...
                    return this._setupbreakpointsevent(bplocs);
                })
                .then(() => {
                    // when all the breakpoints for the newly-prepared type have been set...
                    return this._resumesilent();
                });
        });
    },

    clearBreakOnExceptions: function () {
        return new Promise((resolve, reject) => {
            const next = () => {
                if (!this.exception_ids.length) {
                    resolve();
                    return;
                }
                // clear next pattern
                this.session.adbclient.jdwp_command({
                    cmd: this.JDWP.Commands.ClearExceptionBreak(this.exception_ids.pop())
                })
                    .then(next, reject);
            }
            next();
        });
    },

    setBreakOnExceptions: function (which) {
        const onevent = {
            data: {
            },
            fn: e => {
                // if this exception break occurred during a step request, we must manually clear the event
                // or the (device-side) debugger will crash on next step
                this._clearLastStepRequest(e.event.threadid)
                    .then(() =>
                        this._findcmllocation(this.session.classes, e.event.throwlocation)
                            .then(tloc =>
                                this._findcmllocation(this.session.classes, e.event.catchlocation)
                                    .then(cloc => {
                                        const eventdata = {
                                            event: e.event,
                                            throwlocation: Object.assign({ threadid: e.event.threadid }, tloc),
                                            catchlocation: Object.assign({ threadid: e.event.threadid }, cloc),
                                        };
                                        this.session.stoppedlocation = Object.assign({}, eventdata.throwlocation);
                                        this._trigger('exception', eventdata);
                                    })
                            )
                    );
            }
        };

        let c = false, u = false;
        switch (which) {
            case 'caught': c = true; break;
            case 'uncaught': u = true; break;
            case 'both': c = u = true; break;
            default: throw new Error('Invalid exception option');
        }
        // when setting up the exceptions, we filter by packages containing public classes in the current session
        // - each filter needs a separate call (I think), so we do this as an asynchronous list
        const pkgs = this.session.build.packages;
        const pkgs_to_monitor = c ? Object.keys(pkgs).filter(pkgname => pkgs[pkgname].public_classes.length) : [];

        return new Promise((resolve, reject) => {
            const o = {
                dbgr: this,
                filters: pkgs_to_monitor.map(pkg => `${pkg}.*`),
                caught: c,
                uncaught: u,
                onevent: onevent,
                cmds: [],
                next() {
                    let uncaught = false;
                    if (!this.filters.length) {
                        if (!this.uncaught) {
                            resolve();
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
                        }, reject);
                }
            };
            o.next();
        });
    },

    setThreadNotify: function () {
        const onevent = {
            data: {},
            fn: (e) => {
                // the thread notifiers don't give any location information
                //this.session.stoppedlocation = ...
                this._trigger('threadchange', { state: e.event.state, threadid: e.event.threadid });
            },
        };

        return this.ensureconnected()
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ThreadStartNotify(onevent),
            }))
            .then(() => this.session.adbclient.jdwp_command({
                cmd: this.JDWP.Commands.ThreadEndNotify(onevent),
            }))
    },

    _loadclzinfo: function (signature) {
        return this.gettypedebuginfo(signature)
            .then((classes) => {
                const p = [];
                for (let clz in classes) {
                    p.push(this._ensuremethods(classes[clz]));
                }
                return Promise.all(p).then(() => classes);
            })
            .then((classes) => {
                const p = [];
                for (let clz in classes) {
                    for (let mid in classes[clz].methods) {
                        p.push(this._ensuremethodlines(classes[clz].methods[mid]));
                    }
                }
                return Promise.all(p).then(() => classes);
            });
    },

    _findbplocation: function (classes, bp) {
        // search the classes for a method containing the line
        for (let i in classes) {
            if (!bp.sigpattern.test(classes[i].type.signature))
                continue;
            for (let j in classes[i].methods) {
                const lines = classes[i].methods[j].linetable.lines;
                for (let k in lines) {
                    if (lines[k].linenum === bp.linenum) {
                        // match - save the info for the command later
                        const bploc = {
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
        const m = method.owningclass.type.signature.match(/^L([^;$]+)[$a-zA-Z0-9_]*;$/);
        if (!m)
            return null;
        const lines = method.linetable.lines;
        let prevk = 0;
        for (let k in lines) {
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
            linenum: lines[lines.length - 1].linenum,
            exact: false,
        };
    },

    _findcmllocation: function (classes, loc) {
        // search the classes for a method containing the line
        return this._findmethodasync(classes, loc)
            .then(method => {
                if (!method)
                    return null;
                return this._ensuremethodlines(method)
                    .then(method => {
                        const srcloc = this.line_idx_to_source_location(method, loc.idx);
                        return srcloc;
                    });
            });
    },

    _findmethodasync: function (classes, location) {
        // some locations are null (which causes the jdwp command to fail)
        if (/^0+$/.test(location.cid)) {
            return Promise.resolve(null);
        }
        const m = this._findmethod(classes, location.cid, location.mid);
        if (m) {
            return Promise.resolve(m);
        }
        // convert the classid to a type signature
        return this.session.adbclient.jdwp_command({
            cmd: this.JDWP.Commands.signature(location.cid),
        })
            .then(type => {
                return this.gettypedebuginfo(type.signature);
            })
            .then(classes => {
                const defs = [];
                for (let clz in classes) {
                    defs.push(this._ensuremethods(classes[clz]));
                }
                return Promise.all(defs).then(() => classes);
            })
            .then(classes => {
                const m = this._findmethod(classes, location.cid, location.mid);
                return m;
            });
    },

    _findmethod: function (classes, classid, methodid) {
        for (let clzname in classes) {
            if (classes[clzname]._isdeferred)
                continue;
            if (classes[clzname].info.typeid !== classid)
                continue;
            for (let mid in classes[clzname].methods) {
                if (classes[clzname].methods[mid].methodid !== methodid)
                    continue;
                return classes[clzname].methods[mid];
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
