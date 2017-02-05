'use strict'
const {
	DebugSession,
	ContinuedEvent, InitializedEvent, ExitedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, ThreadEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint } = require('vscode-debugadapter');

// node and external modules
const crypto = require('crypto');
const dom = require('xmldom').DOMParser;
const fs = require('fs');
const Long = require('long');
const path = require('path');
const xpath = require('xpath');

// our stuff
const { ADBClient } = require('./adbclient');
const { Debugger } = require('./debugger');
const $ = require('./jq-promise');
const NumberBaseConverter = require('./nbc');
const { AndroidThread } = require('./threads');
const { D, isEmptyObject } = require('./util');
const { AndroidVariables } = require('./variables');
const ws_proxy = require('./wsproxy').proxy.Server(6037, 5037);
const { JTYPES,exmsg_var_name,ensure_path_end_slash,is_subpath_of,decode_char,variableRefToThreadId,createJavaString } = require('./globals');

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

        // the set of variables used for evalution outside of any thread/frame context
        this._globals = new AndroidVariables(this, 10000);

        // the fifo queue of evaluations (watches, hover, etc)
        this._evals_queue = [];

        // since we want to send breakpoint events, we will assign an id to every event
        // so that the frontend can match events with breakpoints.
        this._breakpointId = 1000;

        //this._frameBaseId  =  0x00010000; // high, so we don't clash with thread id's
        this._sourceRefs = { all:[null] };  // hashmap + array of (non-zero) source references
        this._nextVSCodeThreadId = 0;         // vscode doesn't like thread id reuse (the Android runtime is OK with it)

        // flag to distinguish unexpected disconnection events (initiated from the device) vs user-terminated requests
        this._isDisconnecting = false;

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	initializeRequest(response/*: DebugProtocol.InitializeResponse*/, args/*: DebugProtocol.InitializeRequestArguments*/) {

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

		this.sendResponse(response);
	}

    LOG(msg) {
        D(msg);
        this.sendEvent(new OutputEvent(msg));
    }

    WARN(msg) {
        D(msg = 'Warning: '+msg);
        this.sendEvent(new OutputEvent(msg));
    }

    failRequest(msg, response) {
        // yeah, it can happen sometimes...
        this.WARN(msg);
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
            var now = process.hrtime(), then = thread.stepTimeout._begun;
            clearTimeout(thread.stepTimeout);
            console.log('step took: ' + ((now[0]*1e9+now[1]) -(then[0]*1e9+then[1]))/1e9);
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

        try { D('Launching: ' + JSON.stringify(args)); } catch(ex) {}
        // app_src_root must end in a path-separator for correct validation of sub-paths
        this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
        this.apk_fpn = args.apkFile;

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
                        public_classes: subfiles.filter(sf => /^[a-zA-Z_$][a-zA-Z0-9_$]*\.java$/.test(sf)).map(sf => sf.match(/^(.*)\.java$/)[1])
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

    configurationDoneRequest(response, args) {
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

    disconnectRequest(response, args) {
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
        e.breakpoints.forEach(javabp => {
            // if there's no associated vsbp we're deleting it, so just ignore the update
            if (!javabp.vsbp) return;
            var verified = !!javabp.state.match(/set|enabled/);
            javabp.vsbp.verified = verified;
            javabp.vsbp.message = null;
            this.sendEvent(new BreakpointEvent('updated', javabp.vsbp));
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
        if (!pkginfo || !/\.java$/i.test(srcfpn)) {
            // source file is not a java file or is outside of the known source packages
            // just send back a list of unverified breakpoints
            response.body = {
                breakpoints: args.breakpoints.map(bp => unverified_breakpoint(bp, 'The breakpoint location is not valid'))
            };
    		this.sendResponse(response);
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
                then(javabp => _setup_breakpoints(o, ++idx, javabp_arr));
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
                        response.body = {
                            breakpoints: javabp_arr.map(javabp => javabp.vsbp)
                        };
                        this._dbgr.sendResponse(response);
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
            console.log('threadsRequest: ' + this._threads.array.length);
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
            .fail(e => {
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
        if (!thread.paused) return this.failRequestThreadNotSuspended('Stack trace', args.threadId, response);

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
                const device_api_level = this.dbgr.session.apilevel || '25';
                for (var i= startFrame; i < endFrame; i++) {
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
                    stack.push(new StackFrame(stack_frame_id, name, src, linenum, 0));
                }
                // FIX: trim the stack to exclude anything above the known sources - otherwise an error occurs in the editor when the user tries to view it
                stack = stack.slice(0,highest_known_source+1);
                totalFrames = stack.length;
                // return the frames
                response.body = {
                    stackFrames: stack,
                    totalFrames: totalFrames,
                };
                this.sendResponse(response);
            })
            .fail((e,x) => {
                this.failRequest('No call stack is available', response);
            });
	}

	scopesRequest(response/*: DebugProtocol.ScopesResponse*/, args/*: DebugProtocol.ScopesArguments*/) {
        var threadId = variableRefToThreadId(args.frameId);
        var thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Scopes',threadId, response);
        if (!thread.paused) return this.failRequestThreadNotSuspended('Scopes',threadId, response);

        var scopes = [new Scope("Local", args.frameId, false)];
		response.body = {
			scopes: scopes
		};

        var last_exception = thread.paused.last_exception;
        if (last_exception && !last_exception.objvar) {
            // retrieve the exception object
            this.dbgr.getExceptionLocal(last_exception.exception, {response,scopes,last_exception,thread,args})
                .then((ex_local,x) => {
                    var {response,scopes,last_exception,thread,args} = x;
                    last_exception.objvar = ex_local;
                    thread.allocateExceptionScopeReference(args.frameId);
                    // put the exception first - otherwise it can get lost if there's a lot of locals
                    scopes.unshift(new Scope("Exception: "+ex_local.type.typename, last_exception.scopeRef, false));
            		this.sendResponse(response);
                })
                .fail(e => { this.sendResponse(response); });
            return;
        }
		this.sendResponse(response);
	}

    sourceRequest(response/*: DebugProtocol.SourceResponse*/, args/*: DebugProtocol.SourceArguments*/) {
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
        if (!thread.paused) return this.failRequestThreadNotSuspended('Variables',threadId, response);

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
            var event = new StoppedEvent(thread.paused.reasons[0], thread.vscode_threadid);
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

        // when we step, manually resume the (single) thread we are stepping and remove it from the list of paused threads
        // - any other paused threads should remain suspended during the step
        var t = this.getThread(args.threadId);
        if (!t) return this.failRequestNoThread('Step', args.threadId, response);
        if (!t.paused) return this.failRequestThreadNotSuspended('Step', args.threadId, response);

        t.paused = null;

        this.sendResponse(response);
        // we time the step - if it takes more than 1 second, we switch to any other threads that are waiting
        t.stepTimeout = setTimeout(t => {
            console.log('Step timeout on thread:'+t.threadid);
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
        var {response, args, getvars, thread} = this._evals_queue[0];

        // wait for any locals in the given context to be retrieved
        getvars.then((thread, locals, vars) => {
                return this.evaluate(args.expression, thread, locals, vars);
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

    /*
        Asynchronously evaluate an expression
    */
    evaluate(expression, thread, locals, vars) {
        D('evaluate: ' + expression);

        const reject_evaluation = (msg) => $.Deferred().rejectWith(this, [new Error(msg)]);
        const resolve_evaluation = (value, variablesReference) => $.Deferred().resolveWith(this, [value, variablesReference]);

        if (thread && !thread.paused)
            return reject_evaluation('not available');

        // special case for evaluating exception messages
        // - this is called if the user tries to evaluate ':msg' from the locals
        if (expression===exmsg_var_name) {
            if (thread && thread.paused.last_exception && thread.paused.last_exception.cached) {
                var msglocal = thread.paused.last_exception.cached.find(v => v.name === exmsg_var_name);
                if (msglocal) {
                    return resolve_evaluation(vars._local_to_variable(msglocal).value);
                }
            }
            return reject_evaluation('not available');
        }

        const parse_array_or_fncall = function(e) {
            var arg, res = {arr:[], call:null};
            // pre-call array indexes
            while (e.expr[0] === '[') {
                e.expr = e.expr.slice(1).trim();
                if ((arg = parse_expression(e)) === null) return null;
                res.arr.push(arg);
                if (e.expr[0] !== ']') return null;
                e.expr = e.expr.slice(1).trim();
            }
            if (res.arr.length) return res;
            // method call
            if (e.expr[0] === '(') {
                res.call = []; e.expr = e.expr.slice(1).trim();
                if (e.expr[0] !== ')') {
                    for (;;) {
                        if ((arg = parse_expression(e)) === null) return null;
                        res.call.push(arg);
                        if (e.expr[0] === ')') break;
                        if (e.expr[0] !== ',') return null;
                        e.expr = e.expr.slice(1).trim();
                    }
                }
                e.expr = e.expr.slice(1).trim();
                // post-call array indexes
                while (e.expr[0] === '[') {
                    e.expr = e.expr.slice(1).trim();
                    if ((arg = parse_expression(e)) === null) return null;
                    res.arr.push(arg);
                    if (e.expr[0] !== ']') return null;
                    e.expr = e.expr.slice(1).trim();
                }
            }
            return res;
        }
        const parse_expression_term = function(e) {
            if (e.expr[0] === '(') {
                e.expr = e.expr.slice(1).trim();
                var subexpr = {expr:e.expr};
                var res = parse_expression(subexpr);
                if (res) {
                    if (subexpr.expr[0] !== ')') return null;
                    e.expr = subexpr.expr.slice(1).trim();
                    if (/^(int|long|byte|short|double|float|char|boolean)$/.test(res.root_term) && !res.members.length && !res.array_or_fncall.call && !res.array_or_fncall.arr.length) {
                        // primitive typecast
                        var castexpr = parse_expression_term(e);
                        if (castexpr) castexpr.typecast = res.root_term;
                        res = castexpr;
                    }
                }
                return res;
            }
            var unop = e.expr.match(/^(?:(!\s?)+|(~\s?)+|(?:([+-]\s?)+(?![\d.])))/);
            if (unop) {
                var op = unop[0].replace(/\s/g,'');
                e.expr = e.expr.slice(unop[0].length).trim();
                var res = parse_expression_term(e);
                if (res)  {
                    for (var i=op.length-1; i >= 0; --i)
                        res = { operator:op[i], rhs:res };
                }
                return res;
            }
            var root_term = e.expr.match(/^(?:(true(?![\w$]))|(false(?![\w$]))|(null(?![\w$]))|([a-zA-Z_$][a-zA-Z0-9_$]*)|([+-]?0x[0-9a-fA-F]+[lL]?)|([+-]?0[0-7]+[lL]?)|([+-]?\d+\.\d+(?:[eE][+-]?\d+)?[fFdD]?)|([+-]?\d+[lL]?)|('[^\\']')|('\\[bfrntv0]')|('\\u[0-9a-fA-F]{4}')|("[^"]*"))/);
            if (!root_term) return null;
            var res = {
                root_term: root_term[0],
                root_term_type: ['boolean','boolean','null','ident','hexint','octint','decfloat','decint','char','echar','uchar','string'][[1,2,3,4,5,6,7,8,9,10,11,12].find(x => root_term[x])-1],
                array_or_fncall: null,
                members:[],
                typecast:''
            }
            e.expr = e.expr.slice(res.root_term.length).trim();
            if ((res.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
            // the root term is not allowed to be a method call
            if (res.array_or_fncall.call) return null;
            while (e.expr[0] === '.') {
                // member expression
                e.expr = e.expr.slice(1).trim();
                var m, member_name = e.expr.match(/^:?[a-zA-Z_$][a-zA-Z0-9_$]*/);   // allow : at start for :super and :msg
                if (!member_name) return null;
                res.members.push(m = {member:member_name[0], array_or_fncall:null})
                e.expr = e.expr.slice(m.member.length).trim();
                if ((m.array_or_fncall = parse_array_or_fncall(e)) === null) return null;
            }
            return res;
        }
        const prec = {
            '*':1,'%':1,'/':1,
            '+':2,'-':2,
            '<<':3,'>>':3,'>>>':3,
            '<':4,'>':4,'<=':4,'>=':4,'instanceof':4,
            '==':5,'!=':5,
            '&':6,'^':7,'|':8,'&&':9,'||':10,'?':11,
        }
        const parse_expression = function(e) {
            var res = parse_expression_term(e);

            if (!e.currprec) e.currprec = [12];
            for (;;) {
                var binary_operator = e.expr.match(/^([/%*&|^+-]=|<<=|>>>?=|[><!=]=|=|<<|>>>?|[><]|&&|\|\||[/%*&|^]|\+(?=[^+]|[+][\w\d.])|\-(?=[^-]|[-][\w\d.])|instanceof\b|\?)/ );
                if (!binary_operator) break;
                var precdiff = (prec[binary_operator[0]] || 12) - e.currprec[0];
                if (precdiff > 0) {
                    // bigger number -> lower precendence -> end of (sub)expression
                    break;    
                }
                if (precdiff === 0 && binary_operator[0]!=='?') {
                    // equal precedence, ltr evaluation
                    break;
                }
                // higher or equal precendence
                e.currprec.unshift(e.currprec[0]+precdiff);
                e.expr = e.expr.slice(binary_operator[0].length).trim();
                // current or higher precendence
                if (binary_operator[0]==='?') {
                    res = { condition:res, operator:binary_operator[0], ternary_true:null, ternary_false:null };
                    res.ternary_true = parse_expression(o);
                    symbol(e,':');
                    res.ternary_false = parse_expression(o);
                } else {
                    res = {  lhs:res, operator:binary_operator[0], rhs:parse_expression(e) };
                }
                e.currprec.shift();
            }
            return res;
        }
        const hex_long = long => ('000000000000000' + long.toUnsigned().toString(16)).slice(-16);
        const evaluate_number = (n) => {
            n += '';
            var numtype,m = n.match(/^([+-]?)0([bBxX0-7])(.+)/), base=10;
            if (m) {
                switch(m[2]) {
                    case 'b': base = 2; n = m[1]+m[3]; break;
                    case 'x': base = 16; n = m[1]+m[3]; break;
                    default: base = 8; break;
                }
            }
            if (base !== 16 && /[fFdD]$/.test(n)) {
                numtype = /[fF]$/.test(n) ? 'float' : 'double';
                n = n.slice(0,-1);
            } else if (/[lL]$/.test(n)) {
                numtype = 'long'
                n = n.slice(0,-1);
            } else {
                numtype = /\./.test(n) ? 'double' : 'int';
            }
            if (numtype === 'long') n = hex_long(Long.fromString(n, false, base));
            else if (/^[fd]/.test(numtype)) n = (base === 10) ? parseFloat(n) : parseInt(n, base);
            else n = parseInt(n, base)|0;

            const iszero = /^[+-]?0+(\.0*)?$/.test(n);
            return { vtype:'literal',name:'',hasnullvalue:iszero,type:JTYPES[numtype],value:n,valid:true };
        }
        const evaluate_char = (char) => {
            return { vtype:'literal',name:'',char:char,hasnullvalue:false,type:JTYPES.char,value:char.charCodeAt(0),valid:true };
        }
        const numberify = (local) => {
            //if (local.type.signature==='C') return local.char.charCodeAt(0);
            if (/^[FD]$/.test(local.type.signature))
                return parseFloat(local.value);
            if (local.type.signature==='J')
                return parseInt(local.value,16);
            return parseInt(local.value,10);
        }
        const stringify = (local) => {
            var s;
            if (JTYPES.isString(local.type)) s = local.string;
            else if (JTYPES.isChar(local.type)) s= local.char;
            else if (JTYPES.isPrimitive(local.type)) s = ''+local.value;
            else if (local.hasnullvalue) s= '(null)';
            if (typeof s === 'string')
                return $.Deferred().resolveWith(this,[s]);
            return this.dbgr.invokeToString(local.value, local.info.frame.threadid, local.type.signature)
                .then(s => s.string);
        }
        const evaluate_expression = (expr) => {
            var q = $.Deferred(), local;
            if (expr.operator) {
                const invalid_operator = (unary) => reject_evaluation(`Invalid ${unary?'type':'types'} for operator '${expr.operator}'`),
                    divide_by_zero = () => reject_evaluation('ArithmeticException: divide by zero');
                var lhs_local;
                return !expr.lhs 
                    ? // unary operator
                    evaluate_expression(expr.rhs)
                    .then(rhs_local => {
                        if (expr.operator === '!' && JTYPES.isBoolean(rhs_local.type)) {
                            rhs_local.value = !rhs_local.value;
                            return rhs_local;
                        }
                        else if (expr.operator === '~' && JTYPES.isInteger(rhs_local.type)) {
                            switch (rhs_local.type.typename) {
                                case 'long': rhs_local.value = rhs_local.value.replace(/./g,c => (15 - parseInt(c,16)).toString(16)); break;
                                default: rhs_local = evaluate_number(''+~rhs_local.value); break;
                            }
                            return rhs_local;
                        }
                        else if (/[+-]/.test(expr.operator) && JTYPES.isInteger(rhs_local.type)) {
                            if (expr.operator === '+') return rhs_local;
                            switch (rhs_local.type.typename) {
                                case 'long': rhs_local.value = hex_long(Long.fromString(rhs_local.value,false,16).neg()); break;
                                default: rhs_local = evaluate_number(''+(-rhs_local.value)); break;
                            }
                            return rhs_local;
                        }
                        return invalid_operator('unary');
                    })
                    : // binary operator
                    evaluate_expression(expr.lhs)
                    .then(x => (lhs_local = x) && evaluate_expression(expr.rhs))
                    .then(rhs_local => {
                        if ((lhs_local.type.signature==='J' && JTYPES.isInteger(rhs_local.type))
                            || (rhs_local.type.signature==='J' && JTYPES.isInteger(lhs_local.type))) {
                            // one operand is a long, the other is an integer -> the result is a long
                            var a,b, lbase, rbase;
                            lbase = lhs_local.type.signature==='J' ? 16 : 10;
                            rbase = rhs_local.type.signature==='J' ? 16 : 10;
                            a = Long.fromString(''+lhs_local.value, false, lbase);
                            b = Long.fromString(''+rhs_local.value, false, rbase);
                            switch(expr.operator) {
                                case '+': a = a.add(b); break;
                                case '-': a = a.subtract(b); break;
                                case '*': a = a.multiply(b); break;
                                case '/': if (!b.isZero()) { a = a.divide(b); break } return divide_by_zero();
                                case '%': if (!b.isZero()) { a  = a.mod(b); break; } return divide_by_zero();
                                case '<<': a = a.shl(b); break;
                                case '>>': a = a.shr(b); break;
                                case '>>>': a = a.shru(b); break;
                                case '&': a = a.and(b); break;
                                case '|': a = a.or(b); break;
                                case '^': a = a.xor(b); break;
                                case '==': a = a.eq(b); break;
                                case '!=': a = !a.eq(b); break;
                                case '<': a = a.lt(b); break;
                                case '<=': a = a.lte(b); break;
                                case '>': a = a.gt(b); break;
                                case '>=': a = a.gte(b); break;
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:a,valid:true };
                            return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.long,value:hex_long(a),valid:true };
                        }
                        else if (JTYPES.isInteger(lhs_local.type) && JTYPES.isInteger(rhs_local.type)) {
                            // both are (non-long) integer types
                            var a = numberify(lhs_local), b= numberify(rhs_local);
                            switch(expr.operator) {
                                case '+': a += b; break;
                                case '-': a -= b; break;
                                case '*': a *= b; break;
                                case '/': if (b) { a = Math.trunc(a/b); break } return divide_by_zero();
                                case '%': if (b) { a %= b; break; } return divide_by_zero();
                                case '<<': a<<=b; break;
                                case '>>': a>>=b; break;
                                case '>>>': a>>>=b; break;
                                case '&': a&=b; break;
                                case '|': a|=b; break;
                                case '^': a^=b; break;
                                case '==': a = a===b; break;
                                case '!=': a = a!==b; break;
                                case '<': a = a<b; break;
                                case '<=': a = a<=b; break;
                                case '>': a = a>b; break;
                                case '>=': a = a>=b; break;
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:a,valid:true };
                            return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.int,value:''+a,valid:true };
                        }
                        else if (JTYPES.isNumber(lhs_local.type) && JTYPES.isNumber(rhs_local.type)) {
                            var a = numberify(lhs_local), b= numberify(rhs_local);
                            switch(expr.operator) {
                                case '+': a += b; break;
                                case '-': a -= b; break;
                                case '*': a *= b; break;
                                case '/': a /= b; break;
                                case '==': a = a===b; break;
                                case '!=': a = a!==b; break;
                                case '<': a = a<b; break;
                                case '<=': a = a<=b; break;
                                case '>': a = a>b; break;
                                case '>=': a = a>=b; break;
                                default: return invalid_operator();
                            }
                            if (typeof a === 'boolean')
                                return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:a,valid:true };
                            // one of them must be a float or double
                            var result_type = 'float double'.split(' ')[Math.max("FD".indexOf(lhs_local.type.signature), "FD".indexOf(rhs_local.type.signature))];
                            return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES[result_type],value:''+a,valid:true };
                        }
                        else if (lhs_local.type.signature==='Z' && rhs_local.type.signature==='Z') {
                            // boolean operands
                            var a = lhs_local.value, b = rhs_local.value;
                            switch(expr.operator) {
                                case '&': case '&&': a = a && b; break;
                                case '|': case '||': a = a || b; break;
                                case '^': a = !!(a ^ b); break;
                                case '==': a = a===b; break;
                                case '!=': a = a!==b; break;
                                default: return invalid_operator();
                            }
                            return { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:a,valid:true };
                        }
                        else if (expr.operator === '+' && JTYPES.isString(lhs_local.type)) {
                            return stringify(rhs_local).then(rhs_str => createJavaString(this.dbgr, lhs_local.string + rhs_str,{israw:true}));
                        }
                        return invalid_operator();
                    });
            }
            switch(expr.root_term_type) {
                case 'boolean':
                    local = { vtype:'literal',name:'',hasnullvalue:false,type:JTYPES.boolean,value:expr.root_term!=='false',valid:true };
                    break;
                case 'null':
                    const nullvalue = '0000000000000000'; // null reference value
                    local = { vtype:'literal',name:'',hasnullvalue:true,type:JTYPES.null,value:nullvalue,valid:true };
                    break;
                case 'ident':
                    local = locals && locals.find(l => l.name === expr.root_term);
                    break;
                case 'hexint':
                case 'octint':
                case 'decint':
                case 'decfloat':
                    local = evaluate_number(expr.root_term);
                    break;
                case 'char':
                case 'echar':
                case 'uchar':
                    local = evaluate_char(decode_char(expr.root_term.slice(1,-1)))
                    break;
                case 'string':
                    // we must get the runtime to create string instances
                    q = createJavaString(this.dbgr, expr.root_term);
                    local = {valid:true};   // make sure we don't fail the evaluation
                    break;
            }
            if (!local || !local.valid) return reject_evaluation('not available');
            // we've got the root term variable - work out the rest
            q = expr.array_or_fncall.arr.reduce((q,index_expr) => {
                return q.then(function(index_expr,local) { return evaluate_array_element.call(this,index_expr,local) }.bind(this,index_expr));
            }, q);
            q = expr.members.reduce((q,m) => {
                return q.then(function(m,local) { return evaluate_member.call(this,m,local) }.bind(this,m));
            }, q);
            if (expr.typecast) {
                q = q.then(function(type,local) { return evaluate_cast.call(this,type,local) }.bind(this,expr.typecast) )
            }
            // if it's a string literal, we are already waiting for the runtime to create the string
            // - otherwise, start the evalaution...
            if (expr.root_term_type !== 'string')
                q.resolveWith(this,[local]);
            return q;
        }
        const evaluate_array_element = (index_expr, arr_local) => {
            if (arr_local.type.signature[0] !== '[') return reject_evaluation(`TypeError: cannot apply array index to non-array type '${arr_local.type.typename}'`);
            if (arr_local.hasnullvalue) return reject_evaluation('NullPointerException');
            return evaluate_expression(index_expr)
                .then(function(arr_local, idx_local) {
                    if (!JTYPES.isInteger(idx_local.type)) return reject_evaluation('TypeError: array index is not an integer value');
                    var idx = numberify(idx_local);
                    if (idx < 0 || idx >= arr_local.arraylen) return reject_evaluation(`BoundsError: array index (${idx}) out of bounds. Array length = ${arr_local.arraylen}`);
                    return this.dbgr.getarrayvalues(arr_local, idx, 1)
                }.bind(this,arr_local))
                .then(els => els[0])
        }
        const evaluate_methodcall = (m, obj_local) => {
            return reject_evaluation('Error: method calls are not supported');
        }
        const evaluate_member = (m, obj_local) => {
            if (!JTYPES.isReference(obj_local.type)) return reject_evaluation('TypeError: value is not a reference type');
            if (obj_local.hasnullvalue) return reject_evaluation('NullPointerException');
            var chain;
            if (m.array_or_fncall.call){
                chain = evaluate_methodcall(m, obj_local);
            } 
            // length is a 'fake' field of arrays, so special-case it
            else if (JTYPES.isArray(obj_local.type) && m.member==='length') {
                chain = evaluate_number(obj_local.arraylen);
            }
            // we also special-case :super (for object instances)
            else if (JTYPES.isObject(obj_local.type) && m.member === ':super') {
                chain = this.dbgr.getsuperinstance(obj_local);
            } 
            // anything else must be a real field
            else {
                chain = this.dbgr.getFieldValue(obj_local, m.member, true)
            }

            return chain.then(local => {
                if (m.array_or_fncall.arr.length) {
                    var q = $.Deferred();
                    m.array_or_fncall.arr.reduce((q,index_expr) => {
                        return q.then(function(index_expr,local) { return evaluate_array_element(index_expr,local) }.bind(this,index_expr));
                    }, q);
                    return q.resolveWith(this, [local]);
                }
            });
        }
        const evaluate_cast = (type,local) => {
            if (type === local.type.typename) return local;
            const incompatible_cast = () => reject_evaluation(`Incompatible cast from ${local.type.typename} to ${type}`);
            // boolean cannot be converted from anything else
            if (type === 'boolean' || local.type.typename === 'boolean') return incompatible_cast();
            if (local.type.typename === 'long') {
                // long to something else
                var value = Long.fromString(local.value, true, 16);
                switch(true) {
                    case (type === 'byte'): local = evaluate_number((parseInt(value.toString(16).slice(-2),16) << 24) >> 24); break;
                    case (type === 'short'): local = evaluate_number((parseInt(value.toString(16).slice(-4),16) << 16) >> 16); break;
                    case (type === 'int'): local = evaluate_number((parseInt(value.toString(16).slice(-8),16) | 0)); break;
                    case (type === 'char'): local = evaluate_char(String.fromCharCode(parseInt(value.toString(16).slice(-4),16))); break;
                    case (type === 'float'): local = evaluate_number(value.toSigned().toNumber()+'F'); break;
                    case (type === 'double'): local = evaluate_number(value.toSigned().toNumber() + 'D'); break;
                    default: return incompatible_cast();
                }
            } else {
                switch(true) {
                    case (type === 'byte'): local = evaluate_number((local.value << 24) >> 24); break;
                    case (type === 'short'): local = evaluate_number((local.value << 16) >> 16); break;
                    case (type === 'int'): local = evaluate_number((local.value | 0)); break;
                    case (type === 'long'): local = evaluate_number(local.value+'L');break;
                    case (type === 'char'): local = evaluate_char(String.fromCharCode(local.value|0)); break;
                    case (type === 'float'): break;
                    case (type === 'double'): break;
                    default: return incompatible_cast();
                }
            }
            local.type = JTYPES[type];
            return local;
        }

        var e = { expr:expression.trim() };
        var parsed_expression = parse_expression(e);
        // if there's anything left, it's an error
        if (parsed_expression && !e.expr) {
            // the expression is well-formed - start the (asynchronous) evaluation
            return evaluate_expression(parsed_expression)
                .then(local => {
                    var v = vars._local_to_variable(local);
                    return resolve_evaluation(v.value, v.variablesReference);
                });
        }

        // the expression is not well-formed
        return reject_evaluation('not available');
	}

}


DebugSession.run(AndroidDebugSession);