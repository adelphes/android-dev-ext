/*
    Debugger: thin wrapper around other classes to manage debug connections
*/
const { EventEmitter }= require('events');
const { JDWP } = require('./jdwp');
const { ADBClient } = require('./adbclient');
const { D } = require('./utils/print');
const { sleep } = require('./utils/thread');
const { decodeJavaStringLiteral } = require('./utils/char-decode');
const {
    AttachBuildInfo,
    BreakpointLocation,
    BreakpointOptions,
    DebuggerBreakpoint,
    DebuggerFrameInfo,
    DebuggerMethodInfo,
    DebuggerTypeInfo,
    DebuggerValue,
    DebugSession,
    JavaArrayType,
    JavaBreakpointEvent,
    JavaClassType,
    JavaExceptionEvent,
    JavaTaggedValue,
    JavaThreadInfo,
    JavaType,
    LaunchBuildInfo,
    MethodInvokeArgs,
    SourceLocation,
    TypeNotAvailable,
} = require('./debugger-types');

class Debugger extends EventEmitter {

    constructor () {
        super();
        this.connection = null;

        this.breakpoints = {
            /** @type {DebuggerBreakpoint[]} */
            all: [],
            /** @type {Map<BreakpointID,DebuggerBreakpoint>} */
            byID: new Map(),
        };

        /** @type {JDWPRequestID[]} */
        this.exception_ids = [];

        /** @type {DebugSession} */
        this.session = null;
    }

    static portManager = {
        portrange: { lowest: 31000, highest: 31099 },
        fixedport: 0,
        inuseports: new Set(),
        debuggers: {},
        reserveport: function () {
            if (this.fixedport > 0 && this.fixedport < 65536) {
                this.inuseports.add(this.fixedport);
                return this.fixedport;
            }
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

    /**
     * @param {LaunchBuildInfo} build
     * @param {string} deviceid
     */
    async startDebugSession(build, deviceid) {
        if (this.status() !== 'disconnected') {
            throw new Error('startDebugSession: session already active');
        }
        this.session = new DebugSession(build, deviceid);
        const stdout = await Debugger.runApp(deviceid, build.startCommandArgs, build.postLaunchPause);

        // retrieve the list of debuggable processes
        const named_pids = await Debugger.getDebuggableProcesses(deviceid, 10e3);
        if (named_pids.length === 0) {
            throw new Error(`startDebugSession: No debuggable processes after app launch.`);
        }
        // we assume the newly launched app is the last pid in the list, but try and
        // validate using the process names
        const matched_named_pids = build.pkgname ? named_pids.filter(np => np.name === build.pkgname) : [];
        let pid;
        switch (matched_named_pids.length) {
            case 0:
                // no name match - warn, but choose the last entry anyway
                D('No process name match - choosing last jdwp pid');
                pid = named_pids[named_pids.length - 1].pid;
                break;
            case 1:
                pid = matched_named_pids[0].pid;
                break;
            default:
                // more than one choice - warn, but choose we'll use the last one anyway
                D('Multiple process names match - choosing last matching entry');
                pid = matched_named_pids[matched_named_pids.length - 1].pid;
                break;
        }
        // after connect(), the caller must call resume() to begin
        await this.connect(pid);
        return stdout;
    }

    /**
     * @param {AttachBuildInfo} build
     * @param {number} pid process ID to connect to
     * @param {string} deviceid device ID to connect to
     */
    async attachToProcess(build, pid, deviceid) {
        if (this.status() !== 'disconnected') {
            throw new Error('attachToProcess: session already active')
        }
        this.session = new DebugSession(build, deviceid);
        // after connect(), the caller must call resume() to begin
        await this.connect(pid);
}

    /**
     * @param {string} deviceid Device ID to connect to
     * @param {string[]} launch_cmd_args Array of arguments to pass to 'am start'
     * @param {number} post_launch_pause amount of time (in ms) to wait after each launch attempt
     */
    static async runApp(deviceid, launch_cmd_args, post_launch_pause) {
        // older (<3) versions of Android only allow target components to be specified with -n
        const shell_cmd = {
            command: `am start ${launch_cmd_args.join(' ')}`,
        };
        let retries = 10
        for (;;) {
            D(shell_cmd.command);
            const stdout = await new ADBClient(deviceid).shell_cmd(shell_cmd);
            // running the JDWP command so soon after launching hangs, so give it a breather before continuing
            await sleep(post_launch_pause);
            // failures:
            //  Error: Activity not started...
            // /system/bin/sh: syntax error: unexpected EOF - this happens with invalid am command arguments
            const m = stdout.match(/Error:.*|syntax error:/gi);
            if (!m) {
                // return the stdout from am (it shows the fully qualified component name)
                return stdout.toString().trim();
            }
            else if (retries <= 0){
                throw new Error(stdout.toString().trim());
            }
            retries -= 1;
        }
    }

    /**
     * return a list of deviceids available for debugging
     */
    listConnectedDevices() {
        return new ADBClient().list_devices();
    }

    /**
     * Retrieve a list of debuggable process IDs from a device
     * @param {string} deviceid
     * @param {number} timeout_ms
     */
    static getDebuggablePIDs(deviceid, timeout_ms) {
        return new ADBClient(deviceid).jdwp_list(timeout_ms);
    }

    /**
     * Retrieve a list of debuggable process IDs with process names from a device.
     * For Android, the process name is usually the package name.
     * @param {string} deviceid 
     * @param {number} timeout_ms
     */
    static getDebuggableProcesses(deviceid, timeout_ms) {
        return new ADBClient(deviceid).named_jdwp_list(timeout_ms);
    }

    /**
     * Attach to the debuggable pid
     *   Quite a lot happens in this - we setup port forwarding, complete the JDWP handshake,
     *   setup class loader notifications and call anyone waiting for us.
     *   If anything fails, we call disconnect() to return to a sense of normality.
     * @param {number|null} jdwpid
    */
    async connect(jdwpid) {
        switch (this.status()) {
            case 'connected':
                // already connected
                return;
            case 'connecting':
                // wait for the connection to complete (or fail)
                return this.connection.connectingpromise;
            default:
                if (!jdwpid)
                    throw new Error('Debugger not connected');
                break;
        }

        // from this point on, we are in the "connecting" state until the JDWP handshake is complete
        // (and we mark as connected) or we fail and return to the disconnected state
        this.connection = {
            /** pid of the debuggable process to connect to (on the device) */
            jdwp: jdwpid,
            /** the local port number to use for ADB port-forwarding */
            localport: Debugger.portManager.reserveport(),
            /** set to true once ADB port-forwarding is completed */
            portforwarding: false,
            /** set to true after the JDWP handshake has completed */
            connected: false,
            /** @type {Promise} fulfilled once the connection tasks have completed */
            connectingpromise: null,
        };

        try {
            await (this.connection.connectingpromise = this.performConnectionTasks());
            // at this point, we are ready to go - all the caller needs to do is call resume().
            this.emit('connected');
        } catch(err) {
            this.connection.err = err;
            // force a return to the disconnected state
            this.disconnect();
            throw err;
        }
    }

    async performConnectionTasks() {
        // setup port forwarding
        // note that this call generally succeeds - even if the JDWP pid is invalid
        await new ADBClient(this.session.deviceid).jdwp_forward({
            localport: this.connection.localport,
            jdwp: this.connection.jdwp,
        });
        this.connection.portforwarding = true;

        // after this, the client keeps an open connection until
        // jdwp_disconnect() is called
        this.session.adbclient = new ADBClient(this.session.deviceid);
        try {
            // if the JDWP pid is invalid (doesn't exist, not debuggable, etc) ,this
            // is where it will fail...
            await this.session.adbclient.jdwp_connect({
                localport: this.connection.localport,
                onreply: data => this._onJDWPMessage(data),
                ondisconnect: () => this._onJDWPDisconnect(),
            });
        } catch (e) {
            // provide a slightly more meaningful message than a socket error
            throw new Error(`A debugger connection to pid ${this.connection.jdwp} could not be established. ${e.message}`)
        }
        // handshake has completed
        this.connection.connected = true;

        // call suspend first - we shouldn't really need to do this (as the debugger
        // is already suspended and will not resume until we tell it), but if we
        // don't do this, it logs a complaint...
        await this.suspend();

        // retrieve the JRE reference ID sizes, so we can decode JDWP messages
        const idsizes = await this.session.adbclient
            .jdwp_command({
                cmd: JDWP.Commands.idsizes(),
            });
        JDWP.initDataCoder(idsizes);
                
        // set the class loader event notifier so we can enable breakpoints when the
        // runtime loads the classes
        await this.initClassPrepareForBreakpoints();

        // some types have already been loaded (so we won't receive class-prepare notifications).
        // we can't map breakpoint source locations to already-loaded anonymous types, so we just retrieve
        // a list of all classes for now.
        const all_classes = await this.getAllClasses();
        this.session.loadedClasses = new Set(all_classes.map(x => x.signature));
    }

    /**
     * @param {Buffer} data 
     */
    _onJDWPMessage(data) {
        // decodeReply will resolve the promise associated with
        // any command this reply is in response to.
        return JDWP.decodeReply(data);
    }

    _onJDWPDisconnect() {
        // the JDWP socket has disconnected - terminate the debugger
        this.disconnect();
    }

    /**
     * Returns a resolved Promise if (and when) a debugger connection is established.
     * The promise is rejected if the device has disconnected.
     */
    ensureConnected() {
        // passing null as the jdwpid will cause a fail if the client is not connected (or connecting)
        return this.connect(null);
    }

    /**
     * @returns {'connected'|'connecting'|'disconnected'}
     */
    status() {
        if (!this.connection) return "disconnected";
        if (this.connection.connected) return "connected";
        return "connecting";
    }

    /**
     * Force stop the app running in the current session
     */
    async forceStop() {
        if (!this.session) {
            return;
        }
        if (this.session.build instanceof LaunchBuildInfo) {
            return Debugger.forceStopApp(this.session.deviceid, this.session.build.pkgname);
        }
    }

    /**
     * Sends a 'am force-stop' command to the given device
     * @param {string} deviceid 
     * @param {string} pkgname 
     * @param {boolean} [throw_on_error]
     */
    static async forceStopApp(deviceid, pkgname, throw_on_error = false) {
        try {
            await new ADBClient(deviceid).shell_cmd({
                command: 'am force-stop ' + pkgname,
            });
        } catch(e) {
            if (throw_on_error) {
                throw e;
            }
        }
    }

    /**
     * Perform disconnect tasks and cleanup
     * @return previous state
     */
    async disconnect() {
        // disconnect is called from a variety of failure scenarios
        // so it must be fairly robust in how it undoes stuff
        const previous_state = this.status();
        const connection = this.connection;
        if (!connection)
            return previous_state;

        // from here on in, this instance is in the disconnected state
        this.connection = null;

        // reset the breakpoint states
        this.resetBreakpoints();

        // clear the session
        const adbclient = this.session.adbclient;
        this.session = null;

        // perform the JDWP disconnect
        if (connection.connected) {
            await adbclient.jdwp_disconnect();
        }

        // undo the portforwarding
        // todo: replace remove_all with remove_port
        if (connection.portforwarding) {
            await adbclient.forward_remove_all();
        }

        // mark the port as freed
        if (connection.portforwarding) {
            Debugger.portManager.freeport(connection.localport);
        }

        this.emit('disconnect');
        return previous_state;
    }

    /**
     * Retrieve all the thread IDs from the running app.
     */
    async getJavaThreadIDs() {
        await this.ensureConnected();
        /** @type {JavaThreadID[]} */
        const threads = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.allthreads(),
        });
        return threads;
    }

    /**
     * 
     * @param {JavaThreadID[]} thread_ids 
     */
    async getJavaThreadInfos(thread_ids) {
        const threadinfos = [];
        for (let i=0; i < thread_ids.length; i++) {
            const threadid = thread_ids[i];
            try {
                const name = await this.session.adbclient.jdwp_command({ cmd: JDWP.Commands.threadname(threadid) });
                const status = await this.session.adbclient.jdwp_command({ cmd: JDWP.Commands.threadstatus(threadid) })
                threadinfos.push(new JavaThreadInfo(threadid, name, status));
            } catch(e) {}
        }
        return threadinfos;
    }

    /**
     * Increments or decrements the suspend count for a given thread
     * @param {JavaThreadID} threadid 
     * @param {number} inc 
     */
    updateThreadSuspendCount(threadid, inc) {
        const count = this.session.threadSuspends.get(threadid);
        this.session.threadSuspends.set(threadid, (count | 0) + inc);
    }

    /**
     * Sends a JDWP command to suspend execution
     */
    async suspend() {
        await this.ensureConnected()
        this.emit('suspending');
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.suspend(),
        });
        this.emit('suspended');
    }

    /**
     * Sends a JDWP command to suspend execution of a single thread
     * @param {JavaThreadID} threadid 
     */
    async suspendThread(threadid) {
        await this.ensureConnected();
        try {
            this.updateThreadSuspendCount(threadid, +1);
            await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.suspendthread(threadid),
            });
        } catch(e) {
            this.updateThreadSuspendCount(threadid, -1);
            throw e;
        }
    }

    /**
     * Sends a JDWP command to resume execution
     * @param {boolean} triggers true if 'resuming' and 'resumed' events should be invoked, false if this is a silent resume
     */
    async _resume(triggers) {
        await this.ensureConnected();
        if (triggers) {
            this.emit('resuming');
        }
        this.session.stoppedLocation = null;
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.resume(),
        });
        if (triggers) {
            this.emit('resumed');
        }
    }

    /**
     * Resume execution of a suspended app
     */
    resume() {
        return this._resume(true);
    }

    /**
     * Resume execution of a suspended app without triggering resume events
     */
    _resumesilent() {
        return this._resume(false);
    }

    /**
     * Sends a JDWP command to resume execution of a single thread
     * @param {JavaThreadID} thread_id
     */
    async resumeThread(thread_id) {
        await this.ensureConnected();
        this.updateThreadSuspendCount(thread_id, -1);
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.resumethread(thread_id),
        });
    }

    /**
     * Performs a single step of the given type
     * @param {DebuggerStepType} step_type 
     * @param {JavaThreadID} thread_id 
     */
    async step(step_type, thread_id) {
        await this.ensureConnected();
        this.emit('stepping');
        await this._setupStepEvent(step_type, thread_id);
        await this.resumeThread(thread_id);
    }

    /**
     * Returns the DebuggerBreakpoint at the given location, or null if none exists
     * @param {string} srcfpn 
     * @param {number} line 
     */
    getBreakpointAt(srcfpn, line) {
        const bp_id = DebuggerBreakpoint.makeBreakpointID(srcfpn, line);
        return this.breakpoints.byID.get(bp_id);
    }

    /**
     * Returns the breakpoints that meet the condition specified in a callback function.
     * @param {(value:DebuggerBreakpoint,idx:number,array:DebuggerBreakpoint[]) => boolean} filter_fn 
     */
    findBreakpoints(filter_fn) {
        return this.breakpoints.all.filter(filter_fn);
    }

    /**
     * Sets a breakpoint at the given location
     * @param {string} srcfpn 
     * @param {number} line 
     * @param {BreakpointOptions} options 
     */
    async setBreakpoint(srcfpn, line, options) {
        const existing_bp = this.getBreakpointAt(srcfpn, line);
        if (existing_bp) {
            return existing_bp;
        }
        const newbp = new DebuggerBreakpoint(srcfpn, line, options, 'set');
        this.breakpoints.all.push(newbp);
        this.breakpoints.byID.set(newbp.id, newbp);

        // what happens next depends upon what state we are in
        switch (this.status()) {
            case 'connected':
                newbp.state = 'notloaded';
                await this.initialiseBreakpoint(newbp);
                break;
            case 'connecting':
            case 'disconnected':
            default:
                newbp.state = 'set';
                break;
        }

        return newbp;
    }

    /**
     * 
     * @param {DebuggerBreakpoint} bp 
     */
    async initialiseBreakpoint(bp) {
        // try and load the class - if the runtime hasn't loaded it yet, this will just return a TypeNotAvailable instance
        let classes = await Promise.all(
            [...this.session.loadedClasses]
                .filter(signature => bp.sigpattern.test(signature))
                .map(signature => this.loadClassInfo(signature))
        );
        let bploc = Debugger.findBreakpointLocation(classes, bp);
        if (!bploc) {
            // we couldn't identify a matching location - either the class is not yet loaded or the
            // location doesn't correspond to any code. In case it's the former, make sure we are notified
            // when classes in this package are loaded
            await this._ensureClassPrepareForPackage(bp.pkg);
            return;
        }
        // we found a matching location - set the breakpoint event
        await this._setupBreakpointsEvent([bploc]);
    }

    /**
     * Deletes a set of breakpoints.
     * @param {DebuggerBreakpoint[]} breakpoints 
     */
    removeBreakpoints(breakpoints) {
        // sanitise first to remove duplicates, non-existants, nulls, etc
        const bps_to_clear = [...new Set(breakpoints)].filter(bp => bp && this.breakpoints.all.includes(bp));

        bps_to_clear.forEach(bp => {
            this.breakpoints.byID.delete(bp.id);
            this.breakpoints.all.splice(this.breakpoints.all.indexOf(bp), 1);
        });

        switch (this.status()) {
            case 'connected':
                this.disableBreakpoints(bps_to_clear, 'removed');
                break;
            case 'connecting':
            case 'disconnected':
            default:
                this._changeBPState(bps_to_clear, 'removed');
                break;
        }

        return bps_to_clear;
    }

    /**
     * Retrieve call-stack frames for a thread
     * @param {JavaThreadID} threadid 
     */
    async getFrames(threadid) {
        /** @type {JavaFrame[]} */
        const frames = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.Frames(threadid),
        })
        const methods = await Promise.all(
            frames.map(frame => this._findMethodAsync(this.session.classList, frame.location))
        );
        return frames.map((frame,i) => new DebuggerFrameInfo(frame, methods[i], threadid));
    }

    /**
     * Retrieve the list of local variables for a given fram
     * @param {DebuggerFrameInfo} frame 
     */
    async getLocals(frame) {
        const method = this.findMethod(this.session.classList, frame.location.cid, frame.location.mid);
        if (!method) {
            D(`getLocals: No method in frame location: ${JSON.stringify(frame.location)}`)
            return [];
        }
        await this._ensureMethodVars(method);

        const location_idx = parseInt(frame.location.idx, 16);
        const tags = { '[': 76, B: 66, C: 67, L: 76, F: 70, D: 68, I: 73, J: 74, S: 83, V: 86, Z: 90 };
        const slots = method.vartable.vars.map(v => {
            const tag = tags[v.type.signature[0]];
            if (!tag) {
                return null;
            }
            const code_idx = parseInt(v.codeidx, 16);
            const withincodebounds = (location_idx >= code_idx) && (location_idx < (code_idx + v.length));
            return {
                v,
                slot: v.slot,
                tag,
                valid: withincodebounds,
            };
        });

        const validslots = slots.filter(s => s && s.valid);
        if (!validslots.length) {
            return [];
        }

        return this._getStackValues(frame, validslots);
    }

    /**
     * @param {DebuggerFrameInfo} frame 
     * @param {*} slotinfo 
     * @param {JavaTaggedValue} data 
     */
    async setLocalVariableValue(frame, slotinfo, data) {
        await this.ensureConnected();
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.SetStackValue(frame.threadid, frame.frameid, slotinfo.slot, data),
        });

        const res = await this._getStackValues(frame, [slotinfo]);
        return res[0];
    }

    /**
     * 
     * @param {DebuggerFrameInfo} frame 
     * @param {*[]} validslots 
     */
    async _getStackValues(frame, validslots) {
        try {
            const values = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.GetStackValues(frame.threadid, frame.frameid, validslots),
            });
            const res = await this._makeValues(
                'local',
                validslots.map(x => x.v),
                values,
                { frame, slotinfo: null }
            );

            for (let i = 0; i < res.length; i++)
                res[i].data.slotinfo = validslots[i];// slots[slots.indexOf(validslots[i])];

            return res;
        } catch (e) {
            D(`_getStackValues: failed to retrieve stack values: ${e.message}`);
            return [];
        }
    }

    /**
     * @param {string} signature 
     */
    async getSuperType(signature) {
        if (signature === JavaType.Object.signature)
            throw new Error('java.lang.Object has no super type');

        const typeinfo = await this.getTypeInfo(signature);
        await this._ensureSuperType(typeinfo);
        return typeinfo.super;
    }

    /**
     * @param {DebuggerValue} value 
     */
    async getSuperInstance(value) {
        const supertype = await this.getSuperType(value.type.signature);
        if (value.vtype === 'class') {
            return this.getTypeValue(supertype.signature);
        }
        return new DebuggerValue(value.vtype, supertype, value.value, value.valid, value.hasnullvalue, value.name, value.data);
    }

    async getTypeValue(signature) {
        const typeinfo = await this.getTypeInfo(signature);
        const valid = !(typeinfo instanceof TypeNotAvailable);
        return new DebuggerValue('class', typeinfo.type, typeinfo.info.typeid, valid, false, typeinfo.type.typename, null);
    }

    /**
     * 
     * @param {string} s Java quoted or literal (raw) string
     * @param {{israw:boolean}} [opts]
     */
    async createJavaStringLiteral(s, opts) {
        const string = (opts && opts.israw) ? s : decodeJavaStringLiteral(s);
        await this.ensureConnected();
        const string_ref = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.CreateStringObject(string),
        });
        const keys = [{
            name: '',
            type: JavaType.String,
        }];
        const vars = await this._makeValues('literal', keys, [string_ref], null);
        return vars[0];
    }

    /**
     * @param {DebuggerValue} instance
     * @param {JavaField} field 
     * @param {JavaTaggedValue} new_value 
     */
    async setFieldValue(instance, field, new_value) {
        await this.ensureConnected();
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.SetFieldValue(instance.value, field, new_value),
        });
        return this.getFieldValue(instance, field.name, true);
    }

    /**
     * @param {DebuggerValue} object_value 
     */
    async getFieldValues(object_value) {
        const type = await this.getTypeInfo(object_value.type.signature);
        await this._ensureFields(type);
        return this.fetchFieldValues(object_value, type.info.typeid, type.fields);
    }

    /**
     * @param {DebuggerValue} object_value 
     * @param {JavaTypeID} typeid 
     * @param {JavaField[]} field_list 
     */
    async fetchFieldValues(object_value, typeid, field_list) {
        // the Android runtime now pointlessly barfs into logcat if an instance value is used
        // to retrieve a static field. So, we now split into two calls...
        const splitfields = field_list.reduce((z, f) => {
            if (f.modbits & 8) {
                z.static.push(f);
            } else {
                z.instance.push(f);
            }
            return z;
        }, { instance: [], static: [] });

        // we cannot retrieve instance fields with a class type
        if (object_value.vtype === 'class') {
            splitfields.instance = [];
        }

        // first, the instance values...
        let instance_fieldvalues = [];
        if (splitfields.instance.length) {
            instance_fieldvalues = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.GetFieldValues(object_value.value, splitfields.instance),
            });
        }
        // and now the statics (with a type reference)
        let static_fieldvalues = [];
        if (splitfields.static.length) {
            static_fieldvalues = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.GetStaticFieldValues(typeid, splitfields.static),
            });
        }
        // make sure the fields and values match up...
        const fields = [...splitfields.instance, ...splitfields.static];
        const values = [...instance_fieldvalues, ...static_fieldvalues];
        const res = await this._makeValues('field', fields, values, { objvar: object_value });
        res.forEach((value,i) => {
            value.data.field = fields[i];
            value.fqname = `${object_value.fqname || object_value.name}.${value.name}`;
        });

        return res;
    }

    /**
     * @param {DebuggerValue} object_value 
     * @param {string} fieldname 
     * @param {boolean} includeInherited true if we should search up the super instances, false to only search the current instance
     */
    async getFieldValue(object_value, fieldname, includeInherited) {
        if (!(object_value.type instanceof JavaClassType)) {
            return null;
        }
        // retrieving field values is expensive, so we search through the class
        // fields (which will be cached) until we find a match
        let field, object_type = object_value.type, typeinfo;
        for (;;) {
            typeinfo = await this.getTypeInfo(object_type.signature);
            const fields = await this._ensureFields(typeinfo);
            field = fields.find(f => f.name === fieldname);
            if (field) {
                break;
            }
            if (!includeInherited || object_type.signature === JavaType.Object.signature) {
                const fully_qualified_typename = `${object_value.type.package}.${object_value.type.typename}`;
                throw new Error(`No such field '${fieldname}' in type ${fully_qualified_typename}`);
            }
            object_type = await this.getSuperType(object_type.signature);
        }
        const values = await this.fetchFieldValues(object_value, typeinfo.info.typeid, [field]);
        return values[0];
    }

    /**
     * Retrieve a list of signatures for all classes making up the inheritence tree for the given type.
     * The last entry is always `"Ljava/lang/Object;"`
     * @param {string} signature 
     */
    async getClassInheritanceList(signature) {
        const signatures = [];
        for (;;) {
            const typeinfo = await this.getTypeInfo(signature);
            signatures.push(typeinfo.type.signature);
            await this._ensureSuperType(typeinfo);
            if (typeinfo.super === null) {
                return signatures;
            }
            signature = typeinfo.super.signature;
        }
    }

    /**
     * @param {JavaThreadID} thread_id 
     * @param {JavaObjectID} exception_object_id 
     */
    async getExceptionValue(thread_id, exception_object_id) {
        const typeref = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.GetObjectType(exception_object_id),
        });
        /** @type {JavaType} */
        const type = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.signature(typeref)
        });
        const typeinfo = await this.getTypeInfo(type.signature);
        await this._ensureFields(typeinfo);
        const msg = await this.invokeToString(exception_object_id, thread_id, type.signature);
        const res = await this._makeValues('exception', [{ name: '{ex}', type }], [exception_object_id], { msg });
        return res[0];
    }

    /**
     * @param {JavaObjectID} objectid 
     * @param {JavaThreadID} threadid 
     * @param {DebuggerMethodInfo} method
     * @param {DebuggerValue[]} args 
     * @returns {Promise<DebuggerValue>}
     */
    async invokeMethod(objectid, threadid, method, args) {
        const x = new MethodInvokeArgs(objectid, threadid, method, args);
        // method invokes must be handled sequentially on a per-thread basis, so we add the info
        // to a list and execute them one at a time
        let list = this.session.methodInvokeQueues.get(threadid);
        if (!list) {
            this.session.methodInvokeQueues.set(threadid, list = []);
        }
        // create a new promise to be fulfilled with the result of the invoke
        const result_promise = new Promise(
            (resolve, reject) => x.promise = {resolve, reject}
        );
        // if this is the only item, start the loop to perform the invokes
        if (list.push(x) === 1) {
            while (list.length) {
                try {
                    const result = await this.performMethodInvoke(list[0]);
                    list[0].promise.resolve(result);
                } catch (e) {
                    list[0].promise.reject(e);
                }
                list.shift();
            }
        }
        return result_promise;
    }

    /**
     * @param {MethodInvokeArgs} x
     */
    async performMethodInvoke({ objectid, threadid, method, args }) {

        // convert the arguments to JDWP-compatible values
        const jdwp_args = args.map(arg => JavaTaggedValue.from(arg));

        // invoke the method
        const res = await this.session.adbclient.jdwp_command({
            cmd: method.isStatic
                ? JDWP.Commands.InvokeStaticMethod(threadid, method.owningclass.info.typeid, method.methodid, jdwp_args)
                : JDWP.Commands.InvokeMethod(objectid, threadid, method.owningclass.info.typeid, method.methodid, jdwp_args)
        })
        // res = {return_value, exception}
        if (!/^0+$/.test(res.exception)) {
            // todo - handle reutrn exceptions
            throw new Error('Exception thrown from method invoke');
        }
        const return_typeinfo = await this.getTypeInfo(method.returnTypeSignature);
        const values = await this._makeValues('return', [{ name: '{return}', type: return_typeinfo.type }], [res.return_value], {});
        return values[0];
    }

    /**
     * @param {JavaObjectID} objectid 
     * @param {JavaThreadID} threadid 
     * @param {string} type_signature
     */
    async invokeToString(objectid, threadid, type_signature) {
        const methods = await this.findNamedMethods(type_signature, 'toString', '()Ljava/lang/String;', true);
        return this.invokeMethod(objectid, threadid, methods[0], []);
    }

    /**
     * @param {string} type_signature 
     * @param {string|RegExp} method_name 
     * @param {string|RegExp} method_signature 
     * @param {boolean} first
     */
    async findNamedMethods(type_signature, method_name, method_signature, first) {
        function ismatch (x, y) {
            if (!x || (x === y)) return true;
            return (x instanceof RegExp) && x.test(y);
        }
        let typeinfo = await this.getTypeInfo(type_signature);

        // resolving the methods only resolves the non-inherited methods
        // if we can't find a matching method, we need to search the super types
        /** @type {DebuggerMethodInfo[]} */
        let matches = [];
        for (;;) {
            await this._ensureMethods(typeinfo);
            matches = [
                ...matches,
                ...typeinfo.methods.filter(
                        m => ismatch(method_name, m.name) && ismatch(method_signature, m.genericsig || m.sig)
                    )
            ]
            if (first && matches.length) {
                return [matches[0]];
            }
            if (typeinfo.super === null) {
                return matches;
            }
            // search the supertype
            await this._ensureSuperType(typeinfo);
            typeinfo = await this.getTypeInfo(typeinfo.super.signature);
        }
    }

    /**
     * @param {string} type_signature 
     * @param {string|RegExp} field_name 
     * @param {boolean} first
     */
    async findNamedFields(type_signature, field_name, first) {
        function ismatch (x, y) {
            if (!x || (x === y)) return true;
            return (x instanceof RegExp) && x.test(y);
        }
        let typeinfo = await this.getTypeInfo(type_signature);

        // resolving the methods only resolves the non-inherited methods
        // if we can't find a matching method, we need to search the super types
        /** @type {JavaField[]} */
        let matches = [];
        for (;;) {
            await this._ensureFields(typeinfo);
            matches = [
                ...matches,
                ...typeinfo.fields.filter(f => ismatch(field_name, f.name))
            ]
            if (first && matches.length) {
                return [matches[0]];
            }
            if (typeinfo.super === null) {
                return matches;
            }
            // search the supertype
            await this._ensureSuperType(typeinfo);
            typeinfo = await this.getTypeInfo(typeinfo.super.signature);
        }
    }

    /**
     * Retrieve the UTF8 text of a String object
     * @param {JavaObjectID} string_ref
     * @returns {Promise<string>}
     */
    getStringText(string_ref) {
        return this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.GetStringValue(string_ref),
        });
    }

    /**
     * Retrieve the text length of a String object
     * @param {JavaObjectID} stringref
     */
    async getStringLength(stringref) {
        const typeinfo = await this.getTypeInfo(JavaType.String.signature);
        await this._ensureFields(typeinfo);
        const countfield = typeinfo.fields.find(f => f.name === 'count');
        const count_values = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.GetFieldValues(stringref, [countfield]),
        });
        return count_values[0];
    }

    /**
     * Retrieve a range of array element values
     * @param {DebuggerValue} array
     * @param {number} start first element index
     * @param {number} count number of elements to retrieve
     */
    async getArrayElementValues(array, start, count) {
        if (!(array.type instanceof JavaArrayType)) {
            throw new Error(`getArrayElementValues: object is not an array type`);
        }
        const values = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.GetArrayValues(array.value, start, count),
        });
        const typeinfo = await this.getTypeInfo(array.type.elementType.signature);
        // generate some dummy keys to map against
        const keys = values.map((_,i) =>
            ({
                name: `${start + i}`,
                type: typeinfo.type,
            })
        );
        const elements = await this._makeValues('arrelem', keys, values, { array });
        // assign fully qualified names for the elements
        elements.forEach(element => element.fqname = `${array.fqname||array.name}[${element.name}]`);
        return elements;
    }

    /**
     * Set (fill) an array range with the specified value
     * @param {DebuggerValue} array
     * @param {number} start 
     * @param {number} count 
     * @param {JavaTaggedValue} value 
     */
    async setArrayElements(array, start, count, value) {
        if (!Number.isInteger(start)) {
            throw new Error('setArrayElementValues: Array start index is not an integer');
        }
        if (!Number.isInteger(count)) {
            throw new Error('setArrayElementValues: Array element count is not an integer');
        }
        await this.ensureConnected();
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.SetArrayElements(array.value, start, count, value),
        })
        return this.getArrayElementValues(array, start, count);
    }

    /**
     * Create a new array of DebuggerValues from a set of keys and values
     * @param {DebuggerValueType} vtype 
     * @param {{name:string,type:JavaType}[]} keys 
     * @param {*[]} values 
     * @param {*} data 
     */
    async _makeValues(vtype, keys, values, data) {
        if (!values || !Array.isArray(values)) {
            return [];
        }
        let res = values.map((v,i) =>
            new DebuggerValue(
                vtype,
                keys[i].type,
                v,
                v !== null,
                /^0+$/.test(v),
                keys[i].name,
                {...data}
            ));

        const fetch_values = [];
        // for those fields that are (non-null) arrays, retrieve the length
        res.filter(v => JavaType.isArray(v.type))
            .forEach(f => {
                if (f.hasnullvalue || !f.valid) {
                    return;
                }
                const promise = this.session.adbclient.jdwp_command({
                    cmd: JDWP.Commands.GetArrayLength(f.value),
                })
                    .then(arrlen => f.arraylen = arrlen);
                fetch_values.push(promise);
            });

        // for those fields that are strings, retrieve the string text
        res.filter(v => JavaType.isString(v.type))
            .forEach(f => {
                if (f.hasnullvalue || !f.valid) {
                    return;
                }
                const promise = this.getStringLength(f.value)
                    .then(async len => {
                        if (len > 10000) {
                            f.string = '{string exceeds maximum display length}';
                            f.biglen = len;
                        } else {
                            f.string = await this.getStringText(f.value);
                        }
                    });
                fetch_values.push(promise);
        });

        await Promise.all(fetch_values);
        return res;
    }

    /**
     * Convert a JRE signature to a DebuggerTypeInfo instance
     * @param {string} signature 
     */
    getTypeInfo(signature) {
        // see if we've already retrieved the type for this session
        const cached = this.session.classCache.get(signature);
        if (cached) {
            // return the cached entry
            // - this will either be the DebuggerTypeInfo instance or a promise resolving with the DebuggerTypeInfo instance
            return cached;
        }

        // while we're retrieving it, set a promise in it's place
        // - this prevents multiple requests from being forwarded over JDWP
        const promise = this.fetchTypeInfo(signature);
        this.session.classCache.set(signature, promise);
        return promise;
    }

    /**
     * @param {string} signature 
     */
    async fetchTypeInfo(signature) {
        await this.ensureConnected();
        /** @type {JavaClassInfo[]} */
        const class_infos = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.classinfo(signature),
        });

        // if the runtime has not loaded the type yet, return a dummy class
        if (!class_infos || !class_infos.length) {
            if (this.session) {
                // delete the entry in the cache so that any future requests will
                // perform a new fetch.
                this.session.classCache.delete(signature);
            }
            return new TypeNotAvailable(JavaType.from(signature));
        }

        const typeinfo = new DebuggerTypeInfo(class_infos[0], JavaType.from(signature));

        /** @type {JavaSource[]} */
        let srcinfoarr = [null];
        // querying the source file for array or primitive types causes the app to crash
        if (/^L/.test(signature)) {
            srcinfoarr = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.sourcefile(typeinfo),
            });
        }
        typeinfo.src = srcinfoarr[0];
        if (this.session) {
            this.session.classList.push(typeinfo);
            this.session.classCache.set(signature, typeinfo);
        }
        return typeinfo;
    }

    /**
     * Ensure any 'super' type information is retrieved
     * @param {DebuggerTypeInfo} typeinfo 
     */
    async _ensureSuperType(typeinfo) {
        // a null value implies no super type is valid (eg. Object)
        if (typeinfo.super === null) {
            return null;
        }
        if (typeinfo.super) {
            return typeinfo.super;
        }
        const fetchSuperType = async (typeinfo) => {
            const supertyperef = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.superclass(typeinfo),
            });
            typeinfo.super = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.signature(supertyperef),
            });
            return typeinfo.super;
        }
        // to ensure we don't perform multiple redundant JDWP requests, set the field to the Promise
        // @ts-ignore
        return typeinfo.super = fetchSuperType(typeinfo);
    }

    /**
     * Ensure any type fields information is retrieved
     * @param {DebuggerTypeInfo} typeinfo 
     */
    _ensureFields(typeinfo) {
        if (typeinfo.fields) {
            return typeinfo.fields;
        }
        const fetchFields = async (typeinfo) => {
            /** @type {JavaField[]} */
            const fields = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.fieldsWithGeneric(typeinfo),
            })
            return typeinfo.fields = fields;
        }
        // to ensure we don't perform multiple redundant JDWP requests, set the field to the Promise
        // @ts-ignore
        return typeinfo.fields = fetchFields(typeinfo);
    }

    /**
     * Ensure any type methods information is retrieved
     * @param {DebuggerTypeInfo} typeinfo 
     */
    async _ensureMethods(typeinfo) {
        if (typeinfo.methods) {
            return typeinfo.methods;
        }
        const fetchMethods = async (typeinfo) => {
            const methods = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.methodsWithGeneric(typeinfo),
            })
            return typeinfo.methods = methods.map(m => new DebuggerMethodInfo(m, typeinfo));
        }
        // to ensure we don't perform multiple redundant JDWP requests, set the field to the Promise
        // @ts-ignore
        return typeinfo.methods = fetchMethods(typeinfo);
    }

    /**
     * Ensure any method variables information is retrieved
     * @param {DebuggerMethodInfo} methodinfo 
     */
    _ensureMethodVars(methodinfo) {
        if (methodinfo.vartable) {
            return methodinfo.vartable;
        }
        const fetchMethodVarTable = async (methodinfo) => {
            /** @type {JavaVarTable} */
            const vartable = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.VariableTableWithGeneric(methodinfo.owningclass, methodinfo),
            })
            return methodinfo.setVarTable(vartable);
        }
        // to ensure we don't perform multiple redundant JDWP requests, set the field to the Promise
        // @ts-ignore
        return methodinfo.vartable = fetchMethodVarTable(methodinfo);
    }

    /**
     * Ensure any method code lines information is retrieved
     * @param {DebuggerMethodInfo} methodinfo 
     */
    async _ensureMethodLines(methodinfo) {
        if (methodinfo.linetable) {
            return methodinfo.linetable;
        }
        const fetchMethodLines = async (methodinfo) => {
            /** @type {JavaLineTable} */
            const linetable = await this.session.adbclient.jdwp_command({
                    cmd: JDWP.Commands.lineTable(methodinfo.owningclass, methodinfo),
                })
                // if the request failed, just return a blank table
                .catch(() => DebuggerMethodInfo.NullLineTable);

                // the linetable does not correlate code indexes with line numbers
                // - location searching relies on the table being ordered by code indexes
                linetable.lines.sort(function (a, b) {
                    return (a.linecodeidx === b.linecodeidx) ? 0 : ((a.linecodeidx < b.linecodeidx) ? -1 : +1);
                });
                return methodinfo.setLineTable(linetable);
        }
        // to ensure we don't perform multiple redundant JDWP requests, set the field to the Promise
        // @ts-ignore
        return methodinfo.linetable = fetchMethodLines(methodinfo);
    }

    /**
     * Sends a JDWP command to register for class-prepare events
     * @param {string} pattern signature pattern to match against prepared classes. Only those matching the pattern will cause an event trigger.
     * @param {(event) => void} onprepare 
     */
    _setupClassPrepareEvent(pattern, onprepare) {
        const onevent = {
            fn: (e) => {
                onprepare(e.event);
            }
        };
        return this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.OnClassPrepare(pattern, onevent),
        });
    }

    /**
     * Sends a JDWP command to clear any outstanding step requests for the given thread
     * @param {JavaThreadID} threadid 
     */
    async clearLastStepRequest(threadid) {
        if (!this.session || !this.session.stepIDs.has(threadid))
            return;

        const stepid = this.session.stepIDs.get(threadid);
        this.session.stepIDs.set(threadid, 0);

        return this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.ClearStep(stepid),
        });
    }

    /**
     * 
     * @param {DebuggerStepType} steptype 
     * @param {JavaThreadID} threadid 
     */
    async _setupStepEvent(steptype, threadid) {
        const onevent = {
            fn: async (e) => {
                await this.clearLastStepRequest(e.event.threadid);
                // search the cached classes for a matching source location
                const sloc = await this.javaLocationToSourceLocation(e.event.location, e.event.threadid);
                const stoppedLocation = sloc || new SourceLocation(null, null, false, e.event.threadid);
                const eventdata = {
                    event: e.event,
                    stoppedLocation,
                };
                this.session.stoppedLocation = stoppedLocation;
                this.emit('step', eventdata);
            }
        };

        const res = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.SetSingleStep(steptype, threadid, onevent),
        });
        // save the step id so we can manually clear it if an exception break occurs
        if (this.session && res && res.id) {
            this.session.stepIDs.set(threadid, res.id);
        }
    }

    /**
     * Send SetBreakpoint command to the connected device and register a handler for the event
     * @param {BreakpointLocation[]} locations 
     */
    async _setupBreakpointsEvent(locations) {
        const onevent = {
            data: {
                dbgr: this,
            },
            fn: async (e) => {
                const loc = e.event.location;
                const cmlkey = `${loc.cid}:${loc.mid}:${loc.idx}`;
                // find the DebuggerBreakpoint matching the location
                const bp = this.breakpoints.all.find(bp => bp.enabled && bp.enabled.cml === cmlkey);
                const stoppedLocation = new SourceLocation(bp.qtype, bp.linenum, true, e.event.threadid);
                this.session.stoppedLocation = stoppedLocation;
                const eventdata = new JavaBreakpointEvent(e.event, stoppedLocation, bp);
                // if this was a conditional breakpoint, it will have been automatically cleared
                // - set a new (unconditional) breakpoint in it's place
                if (bp.options.hitcount) {
                    bp.hitcount += bp.options.hitcount;
                    bp.options.hitcount = null;
                    const { bploc } = bp.enabled;
                    const res = await this.session.adbclient.jdwp_command({
                        cmd: JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, null, onevent),
                    });
                    bp.enabled.requestid = res.id;
                } else {
                    bp.hitcount++;
                }
                bp.stopcount++;
                this.emit('bphit', eventdata);
            }
        };

        const enabled_breakpoints = [];
        for (let bploc of locations) {
            const { bp } = bploc;
            const res = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.SetBreakpoint(bploc.c, bploc.m, bploc.l, bp.options.hitcount, onevent),
            });
            // save the JDWP request IDs from the SetBreakpoint command so we can disable the breakpoint later
            bp.setEnabled(bploc, res.id);
            enabled_breakpoints.push(bp);
        }

        this._changeBPState(enabled_breakpoints, 'enabled');
    }

    /**
     * @param {DebuggerBreakpoint[]} breakpoints 
     * @param {BreakpointState} [new_state] 
     */
    async disableBreakpoints(breakpoints, new_state = 'notloaded') {
        const enabled_bps = breakpoints.filter(bp => bp.enabled);
        for (let bp of enabled_bps) {
            await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.ClearBreakpoint(bp.enabled.requestid),
            });
            bp.setDisabled();
        }
        this._changeBPState(enabled_bps, new_state);
    }

    /**
     * Set the internal state of the breakpoints and trigger the 'bpstatechange' event
     * @param {DebuggerBreakpoint[]} breakpoints 
     * @param {BreakpointState} new_state 
     */
    _changeBPState(breakpoints, new_state) {
        if (!breakpoints || !breakpoints.length || !new_state) {
            return;
        }
        breakpoints.forEach(bp => bp.state = new_state);
        this.emit('bpstatechange', {
            breakpoints: breakpoints.slice(),
            newstate: new_state,
        });
    }

    /**
     * Setup class-prepare events for the classes we have breakpoints set for.
     */
    initClassPrepareForBreakpoints() {
        // set all the breakpoints to the notloaded state
        this._changeBPState(this.breakpoints.all, 'notloaded');

        // setup class prepare notifications for all the packages associated with breakpoints
        // when each class is prepared (loaded by the runtime), we initialise any breakpoints for it
        const class_prepare_promises = this.breakpoints.all.map(
            bp => this._ensureClassPrepareForPackage(bp.pkg)
        );

        return Promise.all(class_prepare_promises);
    }

    /**
     * Reset all breakpoints back to disabled set
     */
    resetBreakpoints() {
        this._changeBPState(this.breakpoints.all, 'set');
        this.breakpoints.all.forEach(bp => bp.setDisabled());
    }

    /**
     * Setup a class-prepare event for the given package name
     * @param {string} package_name
     */
    _ensureClassPrepareForPackage(package_name) {
        const filter = `${package_name}.*`;
        if (this.session.classPrepareFilters.has(filter)) {
            return; // already setup
        }
        this.session.classPrepareFilters.add(filter);
        return this._setupClassPrepareEvent(filter, 
            async clz => {
                try {
                    await this._onClassPrepared(clz);
                } catch (e) {
                    D(`_onClassPrepared failed. ${e.message}`)
                }
                // when the class-prepare event triggers, JDWP automatically suspends the app
                // - we must always manually resume to continue...
                this._resumesilent();
            });
    }

    /**
     * Callback when the JDWP class-prepare event triggers
     * @param {JavaClassInfo} prepared_class 
     */
    async _onClassPrepared(prepared_class) {
        // if the class prepare events have overlapping packages (mypackage.*, mypackage.another.*), we will get
        // multiple notifications (which duplicates breakpoints, etc)
        const signature = prepared_class.type.signature;
        if (this.session.loadedClasses.has(signature)) {
            return; // we already know about this
        }
        this.session.loadedClasses.add(signature);
        D('Prepared: ' + signature);
        if (!/^L(.*);$/.test(signature)) {
            // unrecognised type signature - ignore it
            return;
        }

        const classes = [await this.loadClassInfo(signature)];
        const bplocs = this.breakpoints.all
            .map(bp => Debugger.findBreakpointLocation(classes, bp))
            .filter(x => x);

        if (bplocs.length) {
            // set all the breakpoints in one go...
            await this._setupBreakpointsEvent(bplocs);
        }
    }

    /**
     * Send JDWP commands to clear break-on-exception options
     */
    async clearBreakOnExceptions() {
        while (this.exception_ids.length) {
            // clear next pattern
            await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.ClearExceptionBreak(this.exception_ids.pop())
            })
        }
    }

    /**
     * Enable break-on-exceptions. JDWP will send an event when an exception is thrown.
     * @param {ExceptionBreakMode} which 
     */
    async setBreakOnExceptions(which) {
        const onevent = {
            data: {
            },
            fn: async e => {
                // if this exception break occurred during a step request, we must manually clear the event
                // or the (device-side) debugger will crash on next step
                await this.clearLastStepRequest(e.event.threadid);
                // retrieve the catch and throw locations
                const tloc = await this.javaLocationToSourceLocation(e.event.throwlocation, e.event.threadid);
                const cloc = await this.javaLocationToSourceLocation(e.event.catchlocation, e.event.threadid);
                const eventdata = new JavaExceptionEvent(e.event, tloc, cloc);
                this.session.stoppedLocation = eventdata.throwlocation;
                this.emit('exception', eventdata);
            }
        };

        let caught = false, uncaught = false;
        switch (which) {
            case 'caught': caught = true; break;
            case 'uncaught': uncaught = true; break;
            case 'both': caught = uncaught = true; break;
            default: throw new Error(`Invalid exception option: ${which}`);
        }
        // when setting up the exceptions, we filter by packages containing public classes in the current session
        // - each filter needs a separate call (I think), so we do this as an asynchronous list
        const pkgs = this.session.build.packages;
        const pkgs_to_monitor = caught
            ? [...pkgs.keys()].filter(name => pkgs.get(name).public_classes.length)
            : [];

        let filters = pkgs_to_monitor.map(pkg => `${pkg}.*`);
        if (uncaught) {
            // setup the uncaught exception break - with no filter
            filters.push(null);
        }
        for (let filter of filters) {
            // we only enable 'caught' with a package filter
            // - otherwise we end up stopping on every exception in the Android framework
            // (and there are a lot of exceptions thrown)
            const c = !!filter && caught;
            const u = filter !== null;
            const res = await this.session.adbclient.jdwp_command({
                cmd: JDWP.Commands.SetExceptionBreak(filter, c, u, onevent),
            })
            this.exception_ids.push(res.id);
        }
    }

    /**
     * Setup notifiers for thread start and ends
     */
    async setThreadNotify() {
        const onevent = {
            data: {},
            fn: (e) => {
                // the thread notifiers don't give any location information
                this.emit('threadchange', {
                    state: e.event.state,
                    threadid: e.event.threadid,
                });
            },
        };
        await this.ensureConnected();
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.ThreadStartNotify(onevent),
        });
        await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.ThreadEndNotify(onevent),
        });
    }

    /**
     * Return a DebuggerTypeInfo for the given type signature with methods and code lines retrieved
     * @param {string} signature 
     */
    async loadClassInfo(signature) {
        const typeinfo = await this.getTypeInfo(signature);
        // load the methods
        await this._ensureMethods(typeinfo);
        // load the method lines
        await Promise.all(typeinfo.methods.map(m => this._ensureMethodLines(m)));
        return typeinfo;
    }

    /**
     * Search the list of classes for a location matching the breakpoint
     * @param {DebuggerTypeInfo[]} classes 
     * @param {DebuggerBreakpoint} bp
     * @returns {BreakpointLocation}
     */
    static findBreakpointLocation(classes, bp) {
        // search the classes for a method containing the line
        let bploc = null;
        classes.find(c =>
            bp.sigpattern.test(c.type.signature)
                && c.methods.find(m => {
                    const line = m.linetable.lines.find(line => line.linenum === bp.linenum);
                    if (line) {
                        bploc = new BreakpointLocation(bp, c, m, line.linecodeidx);
                        return true;
                    }
                })
        )
        return bploc;
    }

    /**
     * Returns a SourceLocation instance for the given frame or null if the location cannot be determined
     * @param {DebuggerFrameInfo} frame 
     */
    frameToSourceLocation(frame) {
        return this.lineIndexToSourceLocation(frame.method, frame.location.idx, frame.threadid);
    }

    /**
     * Converts the specified method and code index to a SourceLocation
     * @param {DebuggerMethodInfo} method 
     * @param {hex64} idx 
     * @param {JavaThreadID} threadid 
     */
    lineIndexToSourceLocation(method, idx, threadid) {
        if (!method || !method.linetable || !method.linetable.lines || !method.linetable.lines.length) {
            return null;
        }
        const m = method.owningclass.type.signature.match(/^L([^;$]+)[$a-zA-Z0-9_]*;$/);
        if (!m) {
            return null;
        }
        const qualified_type_name = m[1];
        const lines = method.linetable.lines;
        let prevk = 0;
        for (let k=0; k < lines.length; k++) {
            if (lines[k].linecodeidx < idx) {
                prevk = k;
                continue;
            }
            // multi-part expressions can return intermediate idx's
            // - if the idx is not an exact match, use the previous value
            if (lines[k].linecodeidx > idx)
                k = prevk;
            // convert to a file location
            return new SourceLocation(qualified_type_name, lines[k].linenum, lines[k].linecodeidx === idx, threadid);
        }
        // just return the last location in the list
        return new SourceLocation(qualified_type_name, lines[lines.length - 1].linenum, false, threadid);
    }

    /**
     * 
     * @param {JavaLocation} location 
     * @param {JavaThreadID} threadid
     */
    async javaLocationToSourceLocation(location, threadid) {
        // search the classes for a method containing the line
        const method = await this._findMethodAsync(this.session.classList, location);
        if (!method)
            return null;
        await this._ensureMethodLines(method);
        return this.lineIndexToSourceLocation(method, location.idx, threadid);
    }

    /**
     * @param {DebuggerTypeInfo[]} classes 
     * @param {JavaLocation} location 
     */
    async _findMethodAsync(classes, location) {
        // some locations are null (which causes the jdwp command to fail)
        if (/^0+$/.test(location.cid)) {
            return null;
        }
        const m = this.findMethod(classes, location.cid, location.mid);
        if (m) {
            return m;
        }
        return this._findMethodFromLocation(location);
    }

    /**
     * Sends a JDWP command to retrieve the method at the given location
     * @param {JavaLocation} location 
     */
    async _findMethodFromLocation(location) {
        // convert the location classid to a type signature
        /** @type {JavaType} */
        const type = await this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.signature(location.cid),
        });
        // retrieve the type info with methods
        const typeinfo = await this.getTypeInfo(type.signature);
        await this._ensureMethods(typeinfo);
        // search for the method matching the method ID
        return this.findMethod([typeinfo], location.cid, location.mid);
    }

    /**
     * Search the list of classes for a particular method in a class
     * @param {DebuggerTypeInfo[]} classes 
     * @param {JavaClassID} classid 
     * @param {JavaMethodID} methodid 
     */
    findMethod(classes, classid, methodid) {
        const clz = classes.find(c => c.info.typeid === classid);
        const method = clz && clz.methods.find(m => m.methodid === methodid);
        return method || null;
    }

    /**
     * Retrieve a list of class signatures loaded by the runtime.
     * (note that this method is slow - there are usually thousands of classes in the list)
     */
    getAllClasses() {
        return this.session.adbclient.jdwp_command({
            cmd: JDWP.Commands.AllClassesWithGeneric(),
        });

    }
}

module.exports = {
    Debugger,
}
