'use strict'
const {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, ThreadEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Breakpoint } = require('vscode-debugadapter');

// node and external modules
const crypto = require('crypto');
const dom = require('xmldom').DOMParser;
const fs = require('fs');
const os = require('os');
const path = require('path');
const xpath = require('xpath');

// our stuff
const { ADBClient } = require('./adbclient');
const { Debugger } = require('./debugger');
const $ = require('./jq-promise');
const { AndroidThread } = require('./threads');
const { D, onMessagePrint, isEmptyObject } = require('./util');
const { AndroidVariables } = require('./variables');
const { evaluate } = require('./expressions');
const ws_proxy = require('./wsproxy').proxy.Server(6037, 5037);
const { exmsg_var_name, signatureToFullyQualifiedType, ensure_path_end_slash,is_subpath_of,variableRefToThreadId } = require('./globals');

class AndroidDebugSession extends DebugSession {

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 */
    constructor() {
        super();
        // create the Android debugger instance - we proxy requests through this
        this.dbgr = new Debugger();

        // the base folder of the app (where AndroidManifest.xml and source files should be)
        this.app_src_root = '<no appSrcRoot>';
        // the filepathname of the built apk
        this.apk_fpn = '';
        // the apk file content
        this._apk_file_data = null;
        // the file info, hash and manifest data of the apk
        this.apk_file_info = {};
        // hashmap of packages we found in the source tree
        this.src_packages = {};
        // the device we are debugging
        this._device = null;

        // the threads (we know about from the last refreshThreads call)
        // this is implemented as both a hashmap<threadid,AndroidThread> and an array of AndroidThread objects
        this._threads = {
            array:[],
        }
        // path to the the ANDROID_HOME/sources/<api> (only set if it's a valid path)
        this._android_sources_path = '';

        // number of call stack entries to display above the project source
        this.callStackDisplaySize = 1;

        // the set of variables used for evalution outside of any thread/frame context
        this._globals = new AndroidVariables(this, 10000);

        // the fifo queue of evaluations (watches, hover, etc)
        this._evals_queue = [];

        // since we want to send breakpoint events, we will assign an id to every event
        // so that the frontend can match events with breakpoints.
        this._breakpointId = 1000;

        this._sourceRefs = { all:[null] };  // hashmap + array of (non-zero) source references
        this._nextVSCodeThreadId = 0;         // vscode doesn't like thread id reuse (the Android runtime is OK with it)

        // flag to distinguish unexpected disconnection events (initiated from the device) vs user-terminated requests
        this._isDisconnecting = false;

        // trace flag for printing diagnostic messages to the client Output Window
        this.trace = false;

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	initializeRequest(response/*: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments*/) {

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;
        
        // we support some exception options
        response.body.exceptionBreakpointFilters = [
            { label:'All Exceptions', filter:'all', default:false },
            { label:'Uncaught Exceptions', filter:'uncaught', default:true },
        ];

        // we support modifying variable values
		response.body.supportsSetVariable = true;

        // we support hit-count conditional breakpoints
        response.body.supportsHitConditionalBreakpoints = true;

        // we support the new ExceptionInfoRequest
        response.body.supportsExceptionInfoRequest = true;

		this.sendResponse(response);
	}

    LOG(msg) {
        if (!this.trace) {
            D(msg);
        }
        // VSCode no longer auto-newlines output
        this.sendEvent(new OutputEvent(msg + os.EOL));
    }

    WARN(msg) {
        D(msg = 'Warning: '+msg);
        // the message will already be sent if trace is enabled
        if (!this.trace) {
            this.sendEvent(new OutputEvent(msg + os.EOL));
        }
    }

    failRequest(msg, response) {
        // yeah, it can happen sometimes...
        msg && this.WARN(msg);
        if (response) {
            response.success = false;
            this.sendResponse(response);
        }
    }

    cancelRequest(msg, response) {
        D(msg); // just log it in debug - don't output it to the client
        if (response) {
            response.success = false;
            this.sendResponse(response);
        }
    }

    failRequestNoThread(requestName, threadId, response) {
        this.failRequest(`${requestName} failed. Thread ${threadId} not found`, response);
    }

    failRequestThreadNotSuspended(requestName, threadId, response) {
        this.failRequest(`${requestName} failed. Thread ${threadId} is not suspended`, response);
    }

    cancelRequestThreadNotSuspended(requestName, threadId, response) {
        // now that vscode can resume threads before the locals,callstack,etc are retrieved, we only need to cancel the request
        this.cancelRequest(`${requestName} cancelled. Thread ${threadId} is not suspended`, response);
    }

    getThread(id) {
        var t;
        switch(typeof id) {
            case 'string': 
                t = this._threads[id];
                if (!t) {
                    t = new AndroidThread(this, id, ++this._nextVSCodeThreadId);
                    this._threads[id] = this._threads.array[t.vscode_threadid] = t;
                }
                break;
            case 'number': 
                t = this._threads.array[id];
                break;
        }
        return t;
    }

    reportStoppedEvent(reason, location, last_exception) {
        var thread = this.getThread(location.threadid);
        if (thread.stepTimeout) {
            clearTimeout(thread.stepTimeout);
            thread.stepTimeout = null;
        }
        if (thread.paused) {
            // this thread is already in the paused state - ignore the notification
            thread.paused.reasons.push(reason);
            if (last_exception)
                thread.paused.last_exception = last_exception;
            return;
        }
        thread.paused = {
            when: Date.now(),   // when
            reasons: [reason],  // why
            location: Object.assign({},location),   // where
            last_exception: last_exception || null,
            locals_done: {},    // promise to wait on for the stack variables to be evaluated
            stack_frame_vars: {},   // hashmap<variablesReference,varinfo> for the stack frame locals
            stoppedEvent:null,  // event we (eventually) send to vscode
        }
        this.checkPendingThreadBreaks();
    }

    refreshThreads(extra) {
        return this.dbgr.allthreads(extra)
            .then((thread_ids, extra) => this.dbgr.threadinfos(thread_ids, extra))
            .then((threadinfos, extra) => {

                for (var i=0; i < threadinfos.length; i++) {
                    var ti = threadinfos[i];
                    var thread = this.getThread(ti.threadid);
                    if (thread.name === null) {
                        thread.name = ti.name;
                    } else if (thread.name !== ti.name) {
                        // give the thread a new id for VS code
                        delete this._threads.array[thread.vscode_threadid];
                        thread.vscode_threadid = ++this._nextVSCodeThreadId;
                        this._threads.array[thread.vscode_threadid] = thread;
                        thread.name = ti.name;
                    }
                }

                // remove any threads that are no longer in the system
                this._threads.array.reduceRight((threadinfos,t) => {
                    if (!t) return threadinfos;
                    var exists = threadinfos.find(ti => ti.threadid === t.threadid);
                    if (!exists) {
                        delete this._threads[t.threadid];
                        delete this._threads.array[t.vscode_threadid];
                    }
                    return threadinfos;
                },threadinfos);

                return extra;
            })
    }

	launchRequest(response/*: DebugProtocol.LaunchResponse*/, args/*: LaunchRequestArguments*/) {
        if (args && args.trace) {
            this.trace = args.trace;
            onMessagePrint(this.LOG.bind(this));
        }

        try { D('Launching: ' + JSON.stringify(args)); } catch(ex) {}
        // app_src_root must end in a path-separator for correct validation of sub-paths
        this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
        this.apk_fpn = args.apkFile;
        if (typeof args.callStackDisplaySize === 'number' && args.callStackDisplaySize >= 0)
            this.callStackDisplaySize = args.callStackDisplaySize|0;

        // configure the ADB port - if it's undefined, it will set the default value.
        // if it's not a valid port number, any connection request should neatly fail.
        ws_proxy.setADBPort(args.adbPort);

        try {
            // start by scanning the source folder for stuff we need to know about (packages, manifest, etc)
            this.src_packages = this.scanSourceSync(this.app_src_root);
            // warn if we couldn't find any packages (-> no source -> cannot debug anything)
            if (isEmptyObject(this.src_packages.packages))
                this.WARN('No source files found. Check the "appSrcRoot" setting in launch.json');

        } catch(err) {
            // wow, we really didn't make it very far...
            this.LOG(err.message);
            this.LOG('Check the "appSrcRoot" and "apkFile" entries in launch.json');
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        var fail_launch = (msg) => $.Deferred().rejectWith(this, [new Error(msg)]);

        this.LOG('Checking build')
        this.getAPKFileInfo()
            .then(apk_file_info => {
                this.apk_file_info = apk_file_info;
                // check if any source file was modified after the apk
                if (this.src_packages.last_src_modified >= this.apk_file_info.app_modified) {
                    switch (args.staleBuild) {
                        case 'ignore': break;
                        case 'stop': return fail_launch('Build is not up-to-date');
                        case 'warn': 
                        default: this.WARN('Build is not up-to-date. Source files may not match execution when debugging.'); break;
                    }
                }
                // check we have something to launch - we do this again later, but it's a bit better to do it before we start device comms
                var launchActivity = args.launchActivity;
                if (!launchActivity)
                    if (!(launchActivity = this.apk_file_info.launcher))
                        return fail_launch('No valid launch activity found in AndroidManifest.xml or launch.json');

                return new ADBClient().test_adb_connection()
                    .then(err => {
                        // if adb is not running, see if we can start it ourselves using ANDROID_HOME (and a sensible port number)
                        var adbport = ws_proxy.adbport;
                        if (err && args.autoStartADB!==false && process.env.ANDROID_HOME && typeof adbport === 'number' && adbport > 0 && adbport < 65536) {
                            var adbpath = path.join(process.env.ANDROID_HOME, 'platform-tools', /^win/.test(process.platform)?'adb.exe':'adb');
                            var adbargs = ['-P',''+adbport,'start-server'];
                            try {
                                this.LOG([adbpath, ...adbargs].join(' '));
                                var stdout = require('child_process').execFileSync(adbpath, adbargs, {cwd:process.env.ANDROID_HOME, encoding:'utf8'});
                                this.LOG(stdout);
                            } catch (ex) {} // if we fail, it doesn't matter - the device query will fail and the user will have to work it out themselves
                        }
                    })
            })
            .then(() => this.findSuitableDevice(args.targetDevice))
            .then(device => {
                this._device = device;
                this._device.adbclient = new ADBClient(this._device.serial);
                // we've got our device - retrieve the hash of the installed app (or sha1 utility itself if the app is not installed)
                const query_app_hash = `/system/bin/sha1sum $(pm path ${this.apk_file_info.package}|grep -o -e '/.*' || echo '/system/bin/sha1sum')`;
                return this._device.adbclient.shell_cmd({command: query_app_hash});
            })
            .then(sha1sum_output => {
                const installed_hash = sha1sum_output.match(/^[0-9a-fA-F]*/)[0].toLowerCase();
                // does the installed apk hash match the content hash? if, so we don't need to install the app
                if (installed_hash === this.apk_file_info.content_hash) {
                    this.LOG('Current build already installed');
                    return;
                }
                return this.copyAndInstallAPK();
            })
            .then(() => {
                // when we reach here, the app should be installed and ready to be launched
                // - before we continue, splunk the apk file data because node *still* hangs when evaluating large arrays
                this._apk_file_data = null;

                // get the API level of the device
                return this._device.adbclient.shell_cmd({command:'getprop ro.build.version.sdk'});
            })
            .then(apilevel => {
                apilevel = apilevel.trim();

                // look for the android sources folder appropriate for this device
                if (process.env.ANDROID_HOME && apilevel) {
                    var sources_path = path.join(process.env.ANDROID_HOME,'sources','android-'+apilevel);
                    fs.stat(sources_path, (err,stat) => {
                        if (!err && stat && stat.isDirectory())
                            this._android_sources_path = sources_path;
                    });
                }

                // start the launch
                var launchActivity = args.launchActivity;
                if (!launchActivity)
                    if (!(launchActivity = this.apk_file_info.launcher))
                        return fail_launch('No valid launch activity found in AndroidManifest.xml or launch.json');
                var build = {
                    pkgname:this.apk_file_info.package, 
                    packages:Object.assign({}, this.src_packages.packages),
                    launchActivity: launchActivity,
                };
                this.LOG(`Launching ${build.pkgname+'/'+launchActivity} on device ${this._device.serial} [API:${apilevel||'?'}]`);
                return this.dbgr.startDebugSession(build, this._device.serial, launchActivity);
            })
            .then(() => {
                // if we get this far, the debugger is connected and waiting for the resume command
                // - set up some events
                this.dbgr.on('bpstatechange', this, this.onBreakpointStateChange)
                    .on('bphit', this, this.onBreakpointHit)
                    .on('step', this, this.onStep)
                    .on('exception', this, this.onException)
                    .on('threadchange', this, this.onThreadChange)
                    .on('disconnect', this, this.onDebuggerDisconnect);
                this.waitForConfigurationDone = $.Deferred();
                // - tell the client we're initialised and ready for breakpoint info, etc
                this.sendEvent(new InitializedEvent());
                return this.waitForConfigurationDone;
            })
            .then(() => {
                // get the debugger to tell us about any thread creations/terminations
                return this.dbgr.setThreadNotify();
            })
            .then(() => {
                // config is done - we're all set and ready to go!
                D('Continuing app start');
                this.sendResponse(response);
                return this.dbgr.resume();
            })
            .then(() => {
                this.LOG('Application started');
            })
            .fail(e => {
                // exceptions use message, adbclient uses msg
                this.LOG('Launch failed: '+(e.message||e.msg||'No additional information is available'));
                // more info for adb connect errors
                if (/^ADB server is not running/.test(e.msg)) {
                    this.LOG('Make sure the Android SDK Platform Tools are installed and run:');
                    this.LOG('      adb start-server');
                    this.LOG('If you are running ADB on a non-default port, also make sure the adbPort value in your launch.json is correct.');
                }
                // tell the client we're done
                this.sendEvent(new TerminatedEvent(false));
            });
	}

    copyAndInstallAPK() {
        // copy the file to the device
        this.LOG('Deploying current build...');
        return this._device.adbclient.push_file({
            filepathname:'/data/local/tmp/debug.apk',
            filedata:this._apk_file_data,
            filemtime:new Date().getTime(),
        })
        .then(() => {
            // send the install command
            this.LOG('Installing...');
            return this._device.adbclient.shell_cmd({
                command:'pm install -r /data/local/tmp/debug.apk',
                untilclosed:true,
            })
        })
        .then((stdout) => {
            // failures:
            // 	       pkg: x-y-z.apk
            //  Failure [INSTALL_FAILED_OLDER_SDK]
            var m = stdout.match(/Failure\s+\[([^\]]+)\]/g);
            if (m) {
                return $.Deferred().rejectWith(this, [new Error('Installation failed. ' + m[0])]);
            }
        })
    }

    getAPKFileInfo() {
        var done = $.Deferred();
        done.result = { fpn:this.apk_fpn, app_modified:0, content_hash:'', manifest:'', package:'', activities:[], launcher:'' };
        // read the APK
        fs.readFile(this.apk_fpn, (err,apk_file_data) => {
            if (err) return done.rejectWith(this, [new Error('APK read error. ' + err.message)]);
            // debugging is painful when the APK file content is large, so keep the data in a separate field so node
            // doesn't have to evaluate it when we're looking at the apk info
            this._apk_file_data = apk_file_data;
            // save the last modification time of the app
            done.result.app_modified = fs.statSync(done.result.fpn).mtime.getTime();
            // create a SHA-1 hash as a simple way to see if we need to install/update the app
            const h = crypto.createHash('SHA1');
            h.update(apk_file_data);
            done.result.content_hash = h.digest('hex');
            // read the manifest
            fs.readFile(path.join(this.app_src_root,'AndroidManifest.xml'), 'utf8', (err,manifest) => {
                if (err) return done.rejectWith(this, [new Error('Manifest read error. ' + err.message)]);
                done.result.manifest = manifest;
                try {
                    const doc = new dom().parseFromString(manifest);
                    // extract the package name from the manifest
                    const pkg_xpath = '/manifest/@package';
                    done.result.package = xpath.select1(pkg_xpath, doc).value;
                    const android_select = xpath.useNamespaces({"android": "http://schemas.android.com/apk/res/android"});
                    // extract a list of all the (named) activities declared in the manifest
        			const activity_xpath='/manifest/application/activity/@android:name';
                    var nodes = android_select(activity_xpath, doc);
                    nodes && (done.result.activities = nodes.map(n => n.value));

                    // extract the default launcher activity
        			const launcher_xpath='/manifest/application/activity[intent-filter/action[@android:name="android.intent.action.MAIN"] and intent-filter/category[@android:name="android.intent.category.LAUNCHER"]]/@android:name';
                    var nodes = android_select(launcher_xpath, doc);
                    // should we warn if there's more than one?
                    if (nodes && nodes.length >= 1)
                        done.result.launcher = nodes[0].value
                } catch(err) {
                    return done.rejectWith(this, [new Error('Manifest parse failed. ' + err.message)]);
                }
                done.resolveWith(this, [done.result]);
            });
        });
        return done;
    }
    
    scanSourceSync(app_root) {
        try {
            // scan known app folders looking for file changes and package folders
            var p, paths = fs.readdirSync(app_root,'utf8'), done=[];
            var src_packages = {
                last_src_modified: 0,
                packages: {},
            };
            while (paths.length) {
                p = paths.shift();
                // just in case someone has some crazy circular links going on
                if (done.indexOf(p)>=0) continue;
                done.push(p);
                var subfiles = [], stat, fpn = path.join(app_root,p);
                try {
                    stat = fs.statSync(fpn);
                    src_packages.last_src_modified = Math.max(src_packages.last_src_modified, stat.mtime.getTime());
                    if (!stat.isDirectory()) continue;
                    subfiles = fs.readdirSync(fpn, 'utf8');
                }
                catch (err) { continue }
                // ignore folders not starting with a known top-level Android folder
                if (!/^(assets|res|src|main|java)([\\/]|$)/.test(p)) continue;
                // is this a package folder
                var pkgmatch = p.match(/^(src|main|java)[\\/](.+)/);
                if (pkgmatch && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pkgmatch[2].split(/[\\/]/).pop())) {
                    // looks good - add it to the list
                    const src_folder = pkgmatch[1]; // src, main or java
                    const pkgname = pkgmatch[2].replace(/[\\/]/g,'.');
                    src_packages.packages[pkgname] = {
                        package: pkgname,
                        package_path: fpn,
                        srcroot: path.join(app_root,src_folder),
                        public_classes: subfiles.filter(sf => /^[a-zA-Z_$][a-zA-Z0-9_$]*\.(?:java|kt)$/.test(sf)).map(sf => sf.match(/^(.*)\.(?:java|kt)$/)[1])
                    }
                }
                // add the subfiles to the list to process
                paths = subfiles.map(sf => path.join(p,sf)).concat(paths);
            }
            return src_packages;
        } catch(err) {
            throw new Error('Source path error: ' + err.message);
        }
    }

    findSuitableDevice(target_deviceid) {
        this.LOG('Searching for devices...');
        return this.dbgr.list_devices()
            .then(devices => {
                this.LOG(`Found ${devices.length} device${devices.length===1?'':'s'}`);
                var reject;
                if (devices.length === 0) {
                    reject = 'No devices are connected';
                } else if (target_deviceid) {
                    // check (only one of) the requested device is present
                    var matching_devices = devices.filter(d => d.serial === target_deviceid);
                    switch(matching_devices.length) {
                        case 0: reject = `Target device: '${target_deviceid}' is not connected. Connect it or specify an alternate target device in launch.json`; break;
                        case 1: return matching_devices[0];
                        default: reject = `Target device: '${target_deviceid}' has multiple candidates. Connect a single device or specify an alternate target device in launch.json`; break;
                    }
                } else if (devices.length === 1) {
                    // no specific target device and only one device is connected to adb - use it
                    return devices[0];
                } else {
                    // more than one device and no specific target - fail the launch
                    reject = `Multiple devices are connected and no target device is specified in launch.json`;
                    // be nice and list the devices so the user can easily configure
                    devices.forEach(d => this.LOG(`\t${d.serial}\t${d.status}`));
                }
                return $.Deferred().rejectWith(this, [new Error(reject)]);
            })
    }

    configurationDoneRequest(response/*, args*/) {
        D('configurationDoneRequest');
        this.waitForConfigurationDone.resolve();
        this.sendResponse(response);
    }

    onDebuggerDisconnect() {
        // called when we manually disconnect, or from an unexpected disconnection (USB cable disconnect, etc)
        if (!this._isDisconnecting) {
            D('Unexpected disconnection');
            // this is a surprise disconnect (initiated from the device) - tell the client we're done
            this.LOG(`Device disconnected`);
            this.sendEvent(new TerminatedEvent(false));
        }
    }

    disconnectRequest(response/*, args*/) {
        D('disconnectRequest');
        this._isDisconnecting = true;
        // if we're connected, ask ADB to terminate the app
        if (this.dbgr.status() === 'connected')
            this.dbgr.forcestop();
        return this.dbgr.disconnect(response)
            .then((state, response) => {
                if (/^connect/.test(state))
                    this.LOG(`Debugger disconnected`);
                this.sendResponse(response);
                //this.sendEvent(new ExitedEvent(0));
            })
    }

    onBreakpointStateChange(e) {
        D('onBreakpointStateChange');
        e.breakpoints.forEach(javabp => {
            // if there's no associated vsbp we're deleting it, so just ignore the update
            if (!javabp.vsbp) return;
            var verified = !!javabp.state.match(/set|enabled/);
            javabp.vsbp.verified = verified;
            javabp.vsbp.message = null;
            this.sendEvent(new BreakpointEvent('changed', javabp.vsbp));
        });
    }

    onBreakpointHit(e) {
        // if we step into a breakpoint, both onBreakpointHit and onStep will be called
        D('Breakpoint hit: ' + JSON.stringify(e.stoppedlocation));
        this.reportStoppedEvent("breakpoint", e.stoppedlocation);
    }

    /**
     * Called when the user requests a change to breakpoints in a source file
     * Note: all breakpoints in a file are always sent in args, even if they are not changing
     */
	setBreakPointsRequest(response/*: DebugProtocol.SetBreakpointsResponse*/, args/*: DebugProtocol.SetBreakpointsArguments*/) {
		var srcfpn = args.source && args.source.path;
        D('setBreakPointsRequest: ' + srcfpn);

        const unverified_breakpoint = (src_bp,reason) => {
            var bp = new Breakpoint(false,src_bp.line);
            bp.id = ++this._breakpointId;
            bp.message = reason;
            return bp;
        }

        const sendBPResponse = (response, breakpoints) => {
            D('setBreakPointsRequest response ' + JSON.stringify(breakpoints.map(bp => bp.verified)));
            response.body = {
                breakpoints,
            };
    		this.sendResponse(response);
        }

        // the file must lie inside one of the source packages we found (and it must be have a .java extension)
        var srcfolder = path.dirname(srcfpn);
        var pkginfo;
        for (var pkg in this.src_packages.packages) {
            if ((pkginfo = this.src_packages.packages[pkg]).package_path === srcfolder) break;
            pkginfo = null;
        }
        // if it's not in our source packages, check if it's in the Android source file cache
        if (!pkginfo && is_subpath_of(srcfpn, this._android_sources_path)) {
            // create a fake pkginfo to use to construct the bp
            pkginfo = { srcroot:this._android_sources_path }
        }
        if (!pkginfo || !/\.(java|kt)$/i.test(srcfpn)) {
            // source file is not a java file or is outside of the known source packages
            // just send back a list of unverified breakpoints
            sendBPResponse(response, args.breakpoints.map(bp => unverified_breakpoint(bp, 'The breakpoint location is not valid')));
            return;
        }

        // our debugger requires a relative fpn beginning with / , rooted at the java source base folder
        // - it should look like: /some/package/name/abc.java
        var relative_fpn = srcfpn.slice(pkginfo.srcroot.match(/^(.*?)[\\/]?$/)[1].length).replace(/\\/g,'/');

        // delete any existing breakpoints not in the list
        var src_line_nums = args.breakpoints.map(bp => bp.line);
        this.dbgr.clearbreakpoints(javabp => {
            var remove = javabp.srcfpn===relative_fpn && !src_line_nums.includes(javabp.linenum);
            if (remove) javabp.vsbp = null;
            return remove;
        });

        // return the list of new and existing breakpoints
        // - setting a debugger bp is now asynchronous, so we do this as an orderly queue
        const _setup_breakpoints = (o, idx, javabp_arr) => {
            javabp_arr = javabp_arr || [];
            var src_bp = o.args.breakpoints[idx|=0];
            if (!src_bp) {
                // done
                return $.Deferred().resolveWith(this, [javabp_arr]);
            }
            var dbgline = this.convertClientLineToDebugger(src_bp.line);
            var options = {}; 
            if (src_bp.hitCondition) {
                // the hit condition is an expression that requires evaluation
                // until we get more comprehensive evaluation support, just allow integer literals
                var m = src_bp.hitCondition.match(/^\s*(?:0x([0-9a-f]+)|0b([01]+)|0*(\d+([e]\+?\d+)?))\s*$/i);
                var hitcount = m && (m[3] ? parseFloat(m[3]) : m[2] ? parseInt(m[2],2) : parseInt(m[1],16));
                if (!m || hitcount < 0 || hitcount > 0x7fffffff) return unverified_breakpoint(src_bp, 'The breakpoint is configured with an invalid hit count value');
                options.hitcount = hitcount;
            }
            return this.dbgr.setbreakpoint(o.relative_fpn, dbgline, options)
                .then(javabp => {
                    if (!javabp.vsbp) {
                        // state is one of: set,notloaded,enabled,removed
                        var verified = !!javabp.state.match(/set|enabled/);
                        const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(dbgline));
                        // the breakpoint *must* have an id field or it won't update properly
                        bp.id = ++this._breakpointId;
                        if (javabp.state === 'notloaded')
                            bp.message = 'The runtime hasn\'t loaded this code location';
                        javabp.vsbp = bp;
                    }
                    javabp.vsbp.order = idx;
                    javabp_arr.push(javabp);
                }).
                then((/*javabp*/) => _setup_breakpoints(o, ++idx, javabp_arr));
        };

        if (!this._set_breakpoints_queue) {
            this._set_breakpoints_queue = {
                _dbgr:this,
                _queue:[],
                add(item) {
                    if (this._queue.push(item) > 1) return;
                    this._next();
                },
                _setup_breakpoints: _setup_breakpoints,
                _next() {
                    if (!this._queue.length) return;  // done
                    this._setup_breakpoints(this._queue[0]).then(javabp_arr => {
                        // send back the VS Breakpoint instances
                        var response = this._queue[0].response;
                        sendBPResponse(response, javabp_arr.map(javabp => javabp.vsbp));
                        // .. and do the next one
                        this._queue.shift();
                        this._next();
                    });
                },
            };
        }

        this._set_breakpoints_queue.add({args,response,relative_fpn});
	}

    setExceptionBreakPointsRequest(response /*: SetExceptionBreakpointsResponse*/, args /*: SetExceptionBreakpointsArguments*/) {
        this.dbgr.clearBreakOnExceptions({response,args})
            .then(x => {
                if (x.args.filters.includes('all')) {
                    x.set = this.dbgr.setBreakOnExceptions('both', x);
                } else if (x.args.filters.includes('uncaught')) {
                    x.set = this.dbgr.setBreakOnExceptions('uncaught', x);
                } else {
                    x.set = $.Deferred().resolveWith(this, [x]);
                }
                x.set.then(x => this.sendResponse(x.response));
            });
    }

	threadsRequest(response/*: DebugProtocol.ThreadsResponse*/) {
        if (this._threads.array.length) {
            D('threadsRequest: ' + this._threads.array.length);
            response.body = {
                threads: this._threads.array.filter(x=>x).map(t => {
                    var javaid = parseInt(t.threadid, 16);
                    return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name||'<unnamed>'}`);
                })
            };
            this.sendResponse(response);
            return;
        }

        this.refreshThreads(response)
            .then(response => {
                response.body = {
                    threads: this._threads.array.filter(x=>x).map(t => {
                        var javaid = parseInt(t.threadid, 16);
                        return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name}`);
                    })
                };
                this.sendResponse(response);
            })
            .fail(() => {
                response.success = false;
                this.sendResponse(response);
            });
	}

	/**
	 * Returns a stack trace for the given threadId
	 */
	stackTraceRequest(response/*: DebugProtocol.StackTraceResponse*/, args/*: DebugProtocol.StackTraceArguments*/) {

        // debugger threadid's are a padded 64bit hex string
        var thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Stack trace', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Stack trace', args.threadId, response);

        // retrieve the (stack) frames from the debugger
        this.dbgr.getframes(thread.threadid, {response, args, thread})
            .then((frames, x) => {
                // first ensure that the line-tables for all the methods are loaded
                var defs = frames.map(f => this.dbgr._ensuremethodlines(f.method));
                defs.unshift(frames,x);
                return $.when.apply($,defs);
            })
            .then((frames, x) => {
                const startFrame = typeof x.args.startFrame === 'number' ? x.args.startFrame : 0;
                const maxLevels = typeof x.args.levels === 'number' ? x.args.levels : frames.length-startFrame;
                const endFrame = Math.min(startFrame + maxLevels, frames.length);
                var stack = [], totalFrames = frames.length, highest_known_source=0;
                const android_src_path = this._android_sources_path || '{Android SDK}';
                for (var i = startFrame; (i < endFrame) && x.thread.paused; i++) {
                    // the stack_frame_id must be unique across all threads
                    const stack_frame_id = x.thread.addStackFrameVariable(frames[i], i).frameId;
                    const name = `${frames[i].method.owningclass.name}.${frames[i].method.name}`;
                    const pkginfo = this.src_packages.packages[frames[i].method.owningclass.type.package];
                    const srcloc = this.dbgr.line_idx_to_source_location(frames[i].method, frames[i].location.idx);
                    if (!srcloc && !pkginfo) {
                        totalFrames--;
                        continue;  // ignore frames which have no location (they're probably synthetic)
                    }
                    const linenum = srcloc && this.convertDebuggerLineToClient(srcloc.linenum);
                    const sourcefile = frames[i].method.owningclass.src.sourcefile || (frames[i].method.owningclass.type.signature.match(/([^\/$]+)[;$]/)[1]+'.java');
                    var srcRefId = 0;
                    if (!pkginfo) {
                        var sig = frames[i].method.owningclass.type.signature, srcInfo = this._sourceRefs[sig];
                        if (!srcInfo) {
                            this._sourceRefs.all.push(srcInfo = { 
                                id: this._sourceRefs.all.length, 
                                signature:sig,
                                filepath:path.join(android_src_path,frames[i].method.owningclass.type.package.replace(/[.]/g,path.sep), sourcefile),
                                content:null 
                            });
                            this._sourceRefs[sig] = srcInfo;
                        }
                        srcRefId = srcInfo.id;
                    }
                    // if this is not a known package, check if android sources is valid
                    // - if it is, return the expected path - VSCode will auto-load it
                    // - if not, set the path to null and a sourceRequest will be made.
                    const srcpath = pkginfo ? path.join(pkginfo.package_path,sourcefile)
                        : this._android_sources_path ? srcInfo.filepath
                        : null;
                    const src = new Source(sourcefile, srcpath, srcpath ? 0 : srcRefId);
                    pkginfo && (highest_known_source=i);
                    // we don't support column number when reporting source locations (because JDWP only supports line-granularity)
                    // but in order to get the Exception UI to show, we must have a non-zero column
                    const colnum = (!i && x.thread.paused.last_exception && x.thread.paused.reasons[0]==='exception') ? 1 : 0;
                    stack.push(new StackFrame(stack_frame_id, name, src, linenum, colnum));
                }
                // trim the stack to exclude calls above the known sources
                if (this.callStackDisplaySize > 0) {
                    stack = stack.slice(0,highest_known_source+this.callStackDisplaySize);
                    totalFrames = stack.length;
                }
                // return the frames
                response.body = {
                    stackFrames: stack,
                    totalFrames: totalFrames,
                };
                this.sendResponse(response);
            })
            .fail(() => {
                this.failRequest('No call stack is available', response);
            });
	}

	scopesRequest(response/*: DebugProtocol.ScopesResponse*/, args/*: DebugProtocol.ScopesArguments*/) {
        var threadId = variableRefToThreadId(args.frameId);
        var thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Scopes',threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Scopes', threadId, response);

        var scopes = [new Scope("Local", args.frameId, false)];
		response.body = {
			scopes: scopes
		};

        var last_exception = thread.paused.last_exception;
        if (last_exception && !last_exception.objvar) {
            // retrieve the exception object
            thread.allocateExceptionScopeReference(args.frameId);
            this.dbgr.getExceptionLocal(last_exception.exception, {thread,response,scopes,last_exception})
                .then((ex_local,x) => {
                    x.last_exception.objvar = ex_local;
                    return $.when(x, x.thread.getVariables(x.last_exception.scopeRef));
                })
                .then((x, vars) => {
                    var {response,scopes,last_exception} = x;
                    // put the exception first - otherwise it can get lost if there's a lot of locals
                    scopes.unshift(new Scope("Exception: " + last_exception.objvar.type.typename, last_exception.scopeRef, false));
                    this.sendResponse(response);
                    // notify the exceptionInfo who may be waiting on us
                    if (last_exception.waitForExObject) {
                        var def = last_exception.waitForExObject;
                        last_exception.waitForExObject = null;
                        def.resolveWith(this, []);
                    }
                })
                .fail((/*e*/) => { this.sendResponse(response); });
            return;
        }
		this.sendResponse(response);
	}

    sourceRequest(response/*: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments*/) {
        var content = 
`/*
  The source for this class is unavailable.

  Source files for each Android API level can be downloaded using the Android SDK Manager.

  To display the file, you must download the sources matching the API level of your device or
  emulator and ensure that your ANDROID_HOME environment path is configured correctly.
*/
`;
        // don't actually attempt to load the file here - just recheck to see if the sources
        // path is valid yet.
        if (process.env.ANDROID_HOME && this.dbgr.session.apilevel) {
            var sources_path = path.join(process.env.ANDROID_HOME,'sources','android-'+this.dbgr.session.apilevel);
            fs.stat(sources_path, (err,stat) => {
                if (!err && stat && stat.isDirectory())
                    this._android_sources_path = sources_path;
            });
        }

        response.body = { content };
        this.sendResponse(response);
    }

	variablesRequest(response/*: DebugProtocol.VariablesResponse*/, args/*: DebugProtocol.VariablesArguments*/) {
        var threadId = variableRefToThreadId(args.variablesReference);
        var thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Variables',threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Variables',threadId, response);

        thread.getVariables(args.variablesReference)
            .then(vars => {
                response.body = {
                    variables: vars,
                };
                this.sendResponse(response);
            });
	}

    checkPendingThreadBreaks() {
        var stepping_thread = this._threads.array.find(t => t && t.stepTimeout);
        var paused_threads = this._threads.array.filter(t => t && t.paused);
        var stopped_thread = paused_threads.find(t => t.paused.stoppedEvent);
        if (!stopped_thread && !stepping_thread && paused_threads.length) {
            // prioritise any stepped thread (if it's stopped) or whichever other thread stopped first
            var thread;
            var paused_step_thread = paused_threads.find(t => t.paused.reasons.includes("step"));
            if (paused_step_thread) {
                thread = paused_step_thread;
            } else {
                paused_threads.sort((a,b) => a.paused.when - b.paused.when);
                thread = paused_threads[0];
            }
            // if the break was due to a breakpoint and it has since been removed, just resume the thread
            if (thread.paused.reasons.length === 1 && thread.paused.reasons[0] === 'breakpoint') {
                var bp = this.dbgr.breakpoints.bysrcloc[thread.paused.location.qtype + ':' + thread.paused.location.linenum];
                if (!bp) {
                    this.doContinue(thread);
                    return;
                }
            }
            var event = new StoppedEvent(thread.paused.reasons[0], thread.vscode_threadid, thread.paused.last_exception && "Exception thrown");
            thread.paused.stoppedEvent = event;
            this.sendEvent(event);
        }
    }

	doContinue(thread) {
        thread.paused = null;

        this.checkPendingThreadBreaks();
        this.dbgr.resumethread(thread.threadid);
        console.log('');
    }

	continueRequest(response/*: DebugProtocol.ContinueResponse*/, args/*: DebugProtocol.ContinueArguments*/) {
        D('Continue');

        var t = this.getThread(args.threadId);
        if (!t) return this.failRequestNoThread('Continue', args.threadId, response);
        if (!t.paused) return this.failRequestThreadNotSuspended('Continue', args.threadId, response);

        this.sendResponse(response);
        this.doContinue(t);
	}

    /**
     * Called by the debugger after a step operation has completed
     */
    onStep(e) {
        // if we step into a breakpoint, both onBreakpointHit and onStep will be called
        D('step hit: ' + JSON.stringify(e.stoppedlocation));
        this.reportStoppedEvent("step", e.stoppedlocation);
    }

    /**
     * Called by the user to start a step operation
     */
    doStep(which, response, args) {
        D('step '+which);

        var t = this.getThread(args.threadId);
        if (!t) return this.failRequestNoThread('Step', args.threadId, response);
        if (!t.paused) return this.failRequestThreadNotSuspended('Step', args.threadId, response);

        t.paused = null;

        this.sendResponse(response);
        // we time the step - if it takes more than 2 seconds, we switch to any other threads that are waiting
        t.stepTimeout = setTimeout(t => {
            D('Step timeout on thread:'+t.threadid);
            t.stepTimeout = null;
            this.checkPendingThreadBreaks();
        }, 2000, t);
        t.stepTimeout._begun = process.hrtime();
        this.dbgr.step(which, t.threadid);
        console.log('');
    }

	stepInRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.StepInArguments*/) {
        this.doStep('in', response, args);
	}

	nextRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.NextArguments*/) {
        this.doStep('over', response, args);
	}

	stepOutRequest(response/*: DebugProtocol.NextResponse*/, args/*: DebugProtocol.StepOutArguments*/) {
        this.doStep('out', response, args);
	}

    /**
     * Called by the debugger if an exception event is triggered
     */
    onException(e) {
        // it's possible for the debugger to send multiple exception notifications for the same thread, depending on the package filters
        D('exception hit: ' + JSON.stringify(e.throwlocation));
        var last_exception = {
            exception: e.event.exception,
            threadid: e.throwlocation.threadid,
            frameId: null,   // allocated during scopesRequest
            scopeRef: null,   // allocated during scopesRequest
        };
        this.reportStoppedEvent("exception", e.throwlocation, last_exception);
    }

    /**
     * Called by the debugger if a thread start/end event is triggered
     */
    onThreadChange(e) {
        D(`thread ${e.state}: ${e.threadid}(${parseInt(e.threadid,16)})`);
        switch(e.state) {
            case 'start':
                this.dbgr.threadinfos([e.threadid])
                    .then((threadinfos) => {
                        var ti = threadinfos[0], t = this.getThread(ti.threadid), event = new ThreadEvent();
                        t.name = ti.name;
                        event.body = { reason:'started', threadId: t.vscode_threadid };
                        this.sendEvent(event);
                    })
                    .always(() => this.dbgr.resumethread(e.threadid));
                return;
            case 'end':
                var t = this._threads[e.threadid];
                if (t) {
                    t.stepTimeout && clearTimeout(t.stepTimeout) && (t.stepTimeout = null);
                    delete this._threads[e.threadid];
                    delete this._threads.array[t.vscode_threadid];
                    var event = new ThreadEvent();
                    event.body = { reason:'exited', threadId: t.vscode_threadid };
                    this.sendEvent(event);
                    this.checkPendingThreadBreaks();    // in case we were stepping this thread
                }
                break;
        }
        this.dbgr.resumethread(e.threadid);
    }

    setVariableRequest(response/*: DebugProtocol.SetVariableResponse*/, args/*: DebugProtocol.SetVariableArguments*/) {

        var threadId = variableRefToThreadId(args.variablesReference);
        var t = this.getThread(threadId);
        if (!t) return this.failRequestNoThread('Set variable', threadId, response);
        if (!t.paused) return this.failRequestThreadNotSuspended('Set variable', threadId, response);

        t.setVariableValue(args)
            .then(function(response,vsvar) {
                response.body = {
                    value: vsvar.value,
                    type: vsvar.type,
                    variablesReference: vsvar.variablesReference,
                };
                this.sendResponse(response);
            }.bind(this,response))
            .fail(function(response,e) {
                response.success = false;
                response.message = e.message;
                this.sendResponse(response);
            }.bind(this,response));
	}

    /**
     * Called by VSCode to perform watch, console and hover evaluations
     */
	evaluateRequest(response/*: DebugProtocol.EvaluateResponse*/, args/*: DebugProtocol.EvaluateArguments*/) {

        // Some notes to remember:
        // annoyingly, during stepping, the step can complete before the resume has called evaluateRequest on watches.
        //      The order can go: doStep(running=true),onStep(running=false),evaluateRequest(),evaluateRequest()
        // so we end up evaluating twice...
        // also annoyingly, this method is called before the locals in the current stack frame are evaluated
        // and even more annoyingly, Android (or JDWP) seems to get confused on the first request when we're retrieving multiple values, fields, etc
        // so we have to queue them or we end up with strange results

        // look for a matching entry in the list (other than at index:0)
        var previdx = this._evals_queue.findIndex(e => e.args.expression === args.expression);
        if (previdx > 0) {
            // if we find a match, immediately fail the old one and queue the new one
            var prev = this._evals_queue.splice(previdx,1)[0];
            prev.response.success = false;
            prev.response.message = '(evaluating)';
            this.sendResponse(prev.response);
        }
        // if there's no frameId, we are being asked to evaluate the value in the 'global' context
        var getvars;
        if (args.frameId) {
            var threadId = variableRefToThreadId(args.frameId);
            var thread = this.getThread(threadId);
            if (!thread) return this.failRequestNoThread('Evaluate',threadId, response);
            if (!thread.paused) return this.failRequestThreadNotSuspended('Evaluate',threadId, response);
            getvars = thread._ensureLocals(args.frameId).then(frameId => {
                var locals = thread.paused.stack_frame_vars[frameId].locals;
                return $.Deferred().resolve(thread, locals.variableHandles[frameId].cached, locals);
            })
        } else {
            // global context - no locals
            getvars = $.Deferred().resolve(null, [], this._globals);
        }

        this._evals_queue.push({response,args,getvars,thread});

        // if we're currently processing, just wait
        if (this._evals_queue.length > 1) {
            return;
        }

        // begin processing
        this.doNextEvaluateRequest();
    }

    doNextEvaluateRequest() {
        if (!this._evals_queue.length) {
            return;
        }
        var {response, args, getvars} = this._evals_queue[0];

        // wait for any locals in the given context to be retrieved
        getvars.then((thread, locals, vars) => {
                return evaluate(args.expression, thread, locals, vars, this.dbgr);
            })
            .then((value,variablesReference) => {
                response.body = { result:value, variablesReference:variablesReference|0 };
            })
            .fail(e => {
                response.success = false;
                response.message = e.message;
            })
            .always(() => {
                this.sendResponse(response);
                this._evals_queue.shift();
                this.doNextEvaluateRequest();
            })
    }

    exceptionInfoRequest(response /*DebugProtocol.ExceptionInfoResponse*/, args /**/) {
        var thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Exception info', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Exception info', args.threadId, response);
        if (!thread.paused.last_exception) return this.failRequest('No exception available', response);

        if (!thread.paused.last_exception.objvar || !thread.paused.last_exception.cached) {
            // we must wait for the exception object to be retreived as a local (along with the message field)
            if (!thread.paused.last_exception.waitForExObject) {
                thread.paused.last_exception.waitForExObject = $.Deferred().then(() => {
                    // redo the request
                    this.exceptionInfoRequest(response, args);
                });
            }
            return;
        }
        var exobj = thread.paused.last_exception.objvar;
        var exmsg = thread.paused.last_exception.cached.find(v => v.name === exmsg_var_name);
        exmsg = (exmsg && exmsg.string) || '';

        response.body = {
            /** ID of the exception that was thrown. */
            exceptionId: exobj.type.typename,
            /** Descriptive text for the exception provided by the debug adapter. */
            description: exmsg,
            /** Mode that caused the exception notification to be raised. */
            //'never' | 'always' | 'unhandled' | 'userUnhandled';
            breakMode: 'always',
            /** Detailed information about the exception. */
            details: {
                /** Message contained in the exception. */
                message: exmsg,
                /** Short type name of the exception object. */
                typeName: exobj.type.typename,
                /** Fully-qualified type name of the exception object. */
                fullTypeName: signatureToFullyQualifiedType(exobj.type.signature),
                /** Optional expression that can be evaluated in the current scope to obtain the exception object. */
                //evaluateName: "evaluateName",
                /** Stack trace at the time the exception was thrown. */
                //stackTrace: "stackTrace",
                /** Details of the exception contained by this exception, if any. */
                //innerException: [],
            }
        }
        this.sendResponse(response);
    }
}


DebugSession.run(AndroidDebugSession);