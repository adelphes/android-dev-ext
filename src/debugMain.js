'use strict'
const {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, ThreadEvent, OutputEvent,
	Thread, StackFrame, Scope, Source, Breakpoint } = require('vscode-debugadapter');

// node and external modules
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// our stuff
const { ADBClient } = require('./adbclient');
const { Debugger } = require('./debugger');
const { extractManifestFromAPK, parseManifest } = require('./manifest');
const { AndroidThread } = require('./threads');
const { D, onMessagePrint, isEmptyObject, readFile } = require('./util');
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
        // the API level of the device we are debugging
        this.device_api_level = '';
        // the full file path name of the AndroidManifest.xml, taken from the manifestFile launch property
        this.manifest_fpn = '';

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
        let thread;
        switch(typeof id) {
            case 'string': 
                thread = this._threads[id];
                if (!thread) {
                    thread = new AndroidThread(this, id, ++this._nextVSCodeThreadId);
                    this._threads[id] = this._threads.array[thread.vscode_threadid] = thread;
                }
                break;
            case 'number': 
                thread = this._threads.array[id];
                break;
        }
        return thread;
    }

    reportStoppedEvent(reason, location, last_exception) {
        const thread = this.getThread(location.threadid);
        if (thread.stepTimeout) {
            clearTimeout(thread.stepTimeout);
            thread.stepTimeout = null;
        }
        if (thread.paused) {
            // this thread is already in the paused state - ignore the notification
            thread.paused.reasons.push(reason);
            if (last_exception) {
                thread.paused.last_exception = last_exception;
            }
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

    refreshThreads() {
        return this.dbgr.allthreads()
            .then(thread_ids => this.dbgr.threadinfos(thread_ids))
            .then(threadinfos => {
                threadinfos.forEach(threadinfo => {
                    const thread = this.getThread(threadinfo.threadid);
                    if (thread.name === null) {
                        thread.name = threadinfo.name;
                    } else if (thread.name !== threadinfo.name) {
                        // give the thread a new id for VS code
                        delete this._threads.array[thread.vscode_threadid];
                        thread.vscode_threadid = ++this._nextVSCodeThreadId;
                        this._threads.array[thread.vscode_threadid] = thread;
                        thread.name = threadinfo.name;
                    }
                });

                // remove any threads that are no longer in the system
                this._threads.array.reduceRight((threadinfos,thread) => {
                    if (thread) {
                        const exists = threadinfos.find(ti => ti.threadid === thread.threadid);
                        if (!exists) {
                            delete this._threads[thread.threadid];
                            delete this._threads.array[thread.vscode_threadid];
                        }
                    }
                    return threadinfos;
                },threadinfos);
            });
    }

	async launchRequest(response/*: DebugProtocol.LaunchResponse*/, args/*: LaunchRequestArguments*/) {
        if (args && args.trace) {
            this.trace = args.trace;
            onMessagePrint(this.LOG.bind(this));
        }

        try { D('Launching: ' + JSON.stringify(args)); } catch(ex) {}
        // app_src_root must end in a path-separator for correct validation of sub-paths
        this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
        this.apk_fpn = args.apkFile;
        this.manifest_fpn = args.manifestFile;
        this.pmInstallArgs = args.pmInstallArgs;
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

        try {
            this.LOG('Checking build')
            this.apk_file_info = await this.getAPKFileInfo();
            this.checkBuildIsUpToDate(args.staleBuild);

            // check we have something to launch - we do this again later, but it's a bit better to do it before we start device comms
            let launchActivity = args.launchActivity;
            if (!launchActivity)
                if (!(launchActivity = this.apk_file_info.launcher))
                    throw new Error('No valid launch activity found in AndroidManifest.xml or launch.json');

            // make sure ADB exists and is started and look for a device to install on
            await this.checkADBStarted(args.autoStartADB !== false);
            this._device = await this.findSuitableDevice(args.targetDevice);
            this._device.adbclient = new ADBClient(this._device.serial);

            // install the APK we are going to debug
            await this.installAPK();

            // when we reach here, the app should be installed and ready to be launched
            // - we no longer need the APK file data
            this._apk_file_data = null;

            // try and determine the relevant path for the API sources (based upon the API level of the connected device)
            await this.configureAPISourcePath();

            // launch the app
            await this.startLaunchActivity(args.launchActivity);

            // if we get this far, the debugger is connected and waiting for the resume command
            // - set up some events
            this.dbgr.on('bpstatechange', this, this.onBreakpointStateChange)
                .on('bphit', this, this.onBreakpointHit)
                .on('step', this, this.onStep)
                .on('exception', this, this.onException)
                .on('threadchange', this, this.onThreadChange)
                .on('disconnect', this, this.onDebuggerDisconnect);

            // - tell the client we're initialised and ready for breakpoint info, etc
            this.sendEvent(new InitializedEvent());
            await new Promise(resolve => this.waitForConfigurationDone = resolve);

            // get the debugger to tell us about any thread creations/terminations
            await this.dbgr.setThreadNotify();

            // config is done - we're all set and ready to go!
            D('Continuing app start');
            this.sendResponse(response);
            await this.dbgr.resume();
            
            this.LOG('Application started');
        } catch(e) {
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
        }
    }
    
    async checkADBStarted(autoStartADB) {
        const err = await new ADBClient().test_adb_connection();
        // if adb is not running, see if we can start it ourselves using ANDROID_HOME (and a sensible port number)
        const adbport = ws_proxy.adbport;
        if (err && autoStartADB && process.env.ANDROID_HOME && typeof adbport === 'number' && adbport > 0 && adbport < 65536) {
            const adbpath = path.join(process.env.ANDROID_HOME, 'platform-tools', /^win/.test(process.platform)?'adb.exe':'adb');
            const adbargs = ['-P',''+adbport,'start-server'];
            try {
                this.LOG([adbpath, ...adbargs].join(' '));
                const stdout = require('child_process').execFileSync(adbpath, adbargs, {cwd:process.env.ANDROID_HOME, encoding:'utf8'});
                this.LOG(stdout);
            } catch (ex) {} // if we fail, it doesn't matter - the device query will fail and the user will have to work it out themselves
        }
    }

    checkBuildIsUpToDate(staleBuild) {
        // check if any source file was modified after the apk
        if (this.src_packages.last_src_modified >= this.apk_file_info.app_modified) {
            switch (staleBuild) {
                case 'ignore': break;
                case 'stop': throw new Error('Build is not up-to-date');
                case 'warn': 
                default: this.WARN('Build is not up-to-date. Source files may not match execution when debugging.'); break;
            }
        }
    }

    startLaunchActivity(launchActivity) {
        if (!launchActivity)
            if (!(launchActivity = this.apk_file_info.launcher))
                throw new Error('No valid launch activity found in AndroidManifest.xml or launch.json');
        const build = {
            pkgname: this.apk_file_info.package, 
            packages: Object.assign({}, this.src_packages.packages),
            launchActivity,
        };
        this.LOG(`Launching ${build.pkgname+'/'+launchActivity} on device ${this._device.serial} [API:${this.device_api_level||'?'}]`);
        return this.dbgr.startDebugSession(build, this._device.serial, launchActivity);
    }

    async configureAPISourcePath() {
        const apilevel = await this.getDeviceAPILevel();

        // look for the android sources folder appropriate for this device
        if (process.env.ANDROID_HOME && apilevel) {
            const sources_path = path.join(process.env.ANDROID_HOME,'sources',`android-${apilevel}`);
            fs.stat(sources_path, (err,stat) => {
                if (!err && stat && stat.isDirectory())
                    this._android_sources_path = sources_path;
            });
        }
    }

    async getDeviceAPILevel() {
        const apilevel = await this._device.adbclient.shell_cmd({command:'getprop ro.build.version.sdk'});
        this.device_api_level = apilevel.trim();
        return this.device_api_level;
    }
    
    async installAPK() {
        const installed = await this.isAPKInstalled();
        if (installed) {
            this.LOG('Current build already installed');
            return;
        }
        await this.copyAndInstallAPK();
    }

    async isAPKInstalled() {
        // retrieve the hash of the installed app (or sha1 utility itself if the app is not installed)
        const query_app_hash = `/system/bin/sha1sum $(pm path ${this.apk_file_info.package}|grep -o -e '/.*' || echo '/system/bin/sha1sum')`;
        const sha1sum_output = await this._device.adbclient.shell_cmd({command: query_app_hash});
        const installed_hash = sha1sum_output.match(/^[0-9a-fA-F]*/)[0].toLowerCase();

        // does the installed apk hash match the content hash? if, so we don't need to install the app
        return installed_hash === this.apk_file_info.content_hash;
    }

    copyAndInstallAPK() {
        // copy the file to the device
        this.LOG('Deploying current build...');
        const device_apk_fpn = '/data/local/tmp/debug.apk';
        return this._device.adbclient.push_file({
            pathname: device_apk_fpn,
            data: this._apk_file_data,
            mtime: (Date.now() / 1000) | 0,
            perms: 0o100664,
        })
        .then(() => {
            // send the install command
            this.LOG('Installing...');
            const command = `pm install ${Array.isArray(this.pmInstallArgs) ? this.pmInstallArgs.join(' ') : '-r'} ${device_apk_fpn}`;
            D(command);
            return this._device.adbclient.shell_cmd({
                command,
                untilclosed:true,
            })
        })
        .then((stdout) => {
            // failures:
            // 	       pkg: x-y-z.apk
            //  Failure [INSTALL_FAILED_OLDER_SDK]
            const failure_match = stdout.match(/Failure\s+\[([^\]]+)\]/g);
            if (failure_match) {
                throw new Error('Installation failed. ' + failure_match[0]);
            }
            // now the 'pm install' command can have user-defined arguments, we must check that the command
            // is not rejected because of bad values
            const m = stdout.match(/^java.lang.IllegalArgumentException:.+/m);
            if (m) {
                throw new Error('Installation failed. ' + m[0]);
            }
        })
    }

    async getAPKFileInfo() {
        const result = {
            /**
             * the full file path to the APK
             */
            fpn: this.apk_fpn,
            /**
             * last modified time of the APK file (in ms)
             */
            app_modified: 0,
            /**
             * SHA-1 (hex) digest of the APK file
             */
            content_hash:'',
            /**
             * Contents of Android Manifest XML file
             */
            manifest:'',
            /**
             * Package name of the app - extracted from the manifest
             */
            package:'',
            /**
             * List of all named Activities - extracted from the manifest
             */
            activities:[],
            /**
             * The launcher Activity- extracted from the manifest
             */
            launcher:'',
        };
        // read the APK file contents
        try {
            // debugging is painful when the APK file content is large, so keep the data in a separate field so node
            // doesn't have to evaluate it when we're looking at the apk info
            this._apk_file_data = await readFile(this.apk_fpn);
        } catch(err) {
            throw new Error(`APK read error. ${err.message}`);
        }
        // save the last modification time of the app
        result.app_modified = fs.statSync(result.fpn).mtime.getTime();

        // create a SHA-1 hash as a simple way to see if we need to install/update the app
        const h = crypto.createHash('SHA1');
        h.update(this._apk_file_data);
        result.content_hash = h.digest('hex');

        // read the manifest
        try {
            result.manifest = await this.readAndroidManifest();
        } catch (err) {
            throw new Error(`Manifest read error. ${err.message}`);
        }
        // extract the parts we need from the manifest
        try {
            const manifest_data = parseManifest(result.manifest);
            Object.assign(result, manifest_data);
        } catch(err) {
            throw new Error(`Manifest parse failed. ${err.message}`);
        }
        return result;
    }

    async readAndroidManifest() {
        // Because of manifest merging and build-injected properties, the manifest compiled inside
        // the APK is frequently different from the AndroidManifest.xml source file.
        // We try to extract the manifest from 3 sources (in priority order):
        // 1. The 'manifestFile' launch configuration property
        // 2. The decoded manifest from the APK
        // 3. The AndroidManifest.xml file from the root of the source tree.
        let manifest;

        // a value from the manifestFile overrides the default manifest extraction
        // note: there's no validation that the file is a valid AndroidManifest.xml file
        if (this.manifest_fpn) {
            D(`Reading manifest from ${this.manifest_fpn}`);
            manifest = await readFile(this.manifest_fpn, 'utf8');
            return manifest;
        }
    
        try {
            D(`Reading APK Manifest`);
            manifest = await extractManifestFromAPK(this.apk_fpn);
        } catch(err) {
            // if we fail to read the APK manifest, revert to the source manifest
            D(`Reading source manifest from ${this.app_src_root}`);
            manifest = await readFile(path.join(this.app_src_root, 'AndroidManifest.xml'), 'utf8');
        }
        return manifest;
    }
    
    scanSourceSync(app_root) {
        try {
            // scan known app folders looking for file changes and package folders
            let subpaths = fs.readdirSync(app_root,'utf8');
            const done_subpaths = new Set();
            const src_packages = {
                last_src_modified: 0,
                packages: {},
            };
            while (subpaths.length) {
                const subpath = subpaths.shift();
                // just in case someone has some crazy circular links going on
                if (done_subpaths.has(subpath)) {
                    continue;
                }
                done_subpaths.add(subpath);
                let subfiles = [];
                const fpn = path.join(app_root, subpath);
                try {
                    const stat = fs.statSync(fpn);
                    src_packages.last_src_modified = Math.max(src_packages.last_src_modified, stat.mtime.getTime());
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    subfiles = fs.readdirSync(fpn, 'utf8');
                }
                catch (err) {
                    continue;
                }
                // ignore folders not starting with a known top-level Android folder
                if (!(/^(assets|res|src|main|java|kotlin)([\\/]|$)/.test(subpath))) continue;
                // is this a package folder
                const pkgmatch = subpath.match(/^(src|main|java|kotlin)[\\/](.+)/);
                if (pkgmatch && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pkgmatch[2].split(/[\\/]/).pop())) {
                    // looks good - add it to the list
                    const src_folder = pkgmatch[1]; // src, main, java or kotlin
                    const pkgname = pkgmatch[2].replace(/[\\/]/g,'.');
                    src_packages.packages[pkgname] = {
                        package: pkgname,
                        package_path: fpn,
                        srcroot: path.join(app_root,src_folder),
                        public_classes: subfiles.filter(sf => /^[a-zA-Z_$][a-zA-Z0-9_$]*\.(?:java|kt)$/.test(sf)).map(sf => sf.match(/^(.*)\.(?:java|kt)$/)[1])
                    }
                }
                // add the subfiles to the list to process
                subpaths = subfiles.map(sf => path.join(subpath,sf)).concat(subpaths);
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
                let reject;
                if (devices.length === 0) {
                    reject = 'No devices are connected';
                } else if (target_deviceid) {
                    // check (only one of) the requested device is present
                    const matching_devices = devices.filter(d => d.serial === target_deviceid);
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
                throw new Error(reject);
            })
    }

    configurationDoneRequest(response/*, args*/) {
        D('configurationDoneRequest');
        this.waitForConfigurationDone();
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
        this.dbgr.disconnect()
            .then(state => {
                if (/^connect/.test(state)) {
                    this.LOG(`Debugger disconnected`);
                }
                this.sendResponse(response);
                //this.sendEvent(new ExitedEvent(0));
            })
    }

    onBreakpointStateChange(e) {
        D('onBreakpointStateChange');
        e.breakpoints.forEach(javabp => {
            // if there's no associated vsbp we're deleting it, so just ignore the update
            if (!javabp.vsbp) return;
            const verified = !!javabp.state.match(/set|enabled/);
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
		const srcfpn = args.source && args.source.path;
        D('setBreakPointsRequest: ' + srcfpn);

        const unverified_breakpoint = (src_bp,reason) => {
            const bp = new Breakpoint(false,src_bp.line);
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
        const srcfolder = path.dirname(srcfpn);
        let pkginfo;
        for (let pkgname in this.src_packages.packages) {
            pkginfo = this.src_packages.packages[pkgname];
            if (pkginfo.package_path === srcfolder) {
                break;
            }
            pkginfo = null;
        }
        // if we didn't find an exact path match, look for a case-insensitive match
        if (!pkginfo) {
            for (var pkg in this.src_packages.packages) {
                if ((pkginfo = this.src_packages.packages[pkg]).package_path.localeCompare(srcfolder, undefined, { sensitivity: 'base' }) === 0) break;
                pkginfo = null;
            }
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
        const relative_fpn = srcfpn.slice(pkginfo.srcroot.match(/^(.*?)[\\/]?$/)[1].length).replace(/\\/g,'/');

        // delete any existing breakpoints not in the list
        const src_line_nums = args.breakpoints.map(bp => bp.line);
        this.dbgr.clearbreakpoints(javabp => {
            const remove = javabp.srcfpn===relative_fpn && !src_line_nums.includes(javabp.linenum);
            if (remove) javabp.vsbp = null;
            return remove;
        });

        // return the list of new and existing breakpoints
        // - setting a debugger bp is now asynchronous, so we do this as an orderly queue
        const _setup_breakpoints = (o, idx, javabp_arr) => {
            javabp_arr = javabp_arr || [];
            const src_bp = o.args.breakpoints[idx|=0];
            if (!src_bp) {
                // done
                return Promise.resolve(javabp_arr);
            }
            const dbgline = this.convertClientLineToDebugger(src_bp.line);
            const options = {}; 
            if (src_bp.hitCondition) {
                // the hit condition is an expression that requires evaluation
                // until we get more comprehensive evaluation support, just allow integer literals
                const m = src_bp.hitCondition.match(/^\s*(?:0x([0-9a-f]+)|0b([01]+)|0*(\d+([e]\+?\d+)?))\s*$/i);
                const hitcount = m && (m[3] ? parseFloat(m[3]) : m[2] ? parseInt(m[2],2) : parseInt(m[1],16));
                if (!m || hitcount < 0 || hitcount > 0x7fffffff) return unverified_breakpoint(src_bp, 'The breakpoint is configured with an invalid hit count value');
                options.hitcount = hitcount;
            }
            return this.dbgr.setbreakpoint(o.relative_fpn, dbgline, options)
                .then(javabp => {
                    if (!javabp.vsbp) {
                        // state is one of: set,notloaded,enabled,removed
                        const verified = !!javabp.state.match(/set|enabled/);
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
                        const response = this._queue[0].response;
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
        this.dbgr.clearBreakOnExceptions()
            .then(() => {
                let set_promise;
                if (args.filters.includes('all')) {
                    set_promise = this.dbgr.setBreakOnExceptions('both');
                } else if (args.filters.includes('uncaught')) {
                    set_promise = this.dbgr.setBreakOnExceptions('uncaught');
                } else {
                    set_promise = Promise.resolve();
                }
                set_promise.then(() => this.sendResponse(response));
            });
    }

	threadsRequest(response/*: DebugProtocol.ThreadsResponse*/) {
        if (this._threads.array.length) {
            D('threadsRequest: ' + this._threads.array.length);
            response.body = {
                threads: this._threads.array.filter(x=>x).map(t => {
                    const javaid = parseInt(t.threadid, 16);
                    return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name||'<unnamed>'}`);
                })
            };
            this.sendResponse(response);
            return;
        }

        this.refreshThreads()
            .then(() => {
                response.body = {
                    threads: this._threads.array.filter(x=>x).map(t => {
                        const javaid = parseInt(t.threadid, 16);
                        return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name}`);
                    })
                };
                this.sendResponse(response);
            })
            .catch(() => {
                response.success = false;
                this.sendResponse(response);
            })
	}

	/**
	 * Returns a stack trace for the given threadId
	 */
	stackTraceRequest(response/*: DebugProtocol.StackTraceResponse*/, args/*: DebugProtocol.StackTraceArguments*/) {

        // debugger threadid's are a padded 64bit hex string
        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Stack trace', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Stack trace', args.threadId, response);

        // retrieve the (stack) frames from the debugger
        this.dbgr.getframes(thread.threadid)
            .then(frames => {
                // first ensure that the line-tables for all the methods are loaded
                const defs = frames.map(f => this.dbgr._ensuremethodlines(f.method));
                return Promise.all(defs).then(() => frames);
            })
            .then(frames => {
                const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
                const maxLevels = typeof args.levels === 'number' ? args.levels : frames.length-startFrame;
                const endFrame = Math.min(startFrame + maxLevels, frames.length);
                let stack = [];
                let totalFrames = frames.length;
                let highest_known_source = 0;
                const android_src_path = this._android_sources_path || '{Android SDK}';
                for (let i = startFrame; (i < endFrame) && thread.paused; i++) {
                    // the stack_frame_id must be unique across all threads
                    const stack_frame_id = thread.addStackFrameVariable(frames[i], i).frameId;
                    const name = `${frames[i].method.owningclass.name}.${frames[i].method.name}`;
                    const pkginfo = this.src_packages.packages[frames[i].method.owningclass.type.package];
                    const srcloc = this.dbgr.line_idx_to_source_location(frames[i].method, frames[i].location.idx);
                    if (!srcloc && !pkginfo) {
                        totalFrames--;
                        continue;  // ignore frames which have no location (they're probably synthetic)
                    }
                    const linenum = srcloc && this.convertDebuggerLineToClient(srcloc.linenum);
                    const sourcefile = frames[i].method.owningclass.src.sourcefile || (frames[i].method.owningclass.type.signature.match(/([^\/$]+)[;$]/)[1]+'.java');
                    let srcRefId = 0;
                    let srcInfo;
                    if (!pkginfo) {
                        const sig = frames[i].method.owningclass.type.signature;
                        srcInfo = this._sourceRefs[sig];
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
                    const colnum = (!i && thread.paused.last_exception && thread.paused.reasons[0]==='exception') ? 1 : 0;
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
            .catch(() => {
                this.failRequest('No call stack is available', response);
            });
	}

	scopesRequest(response/*: DebugProtocol.ScopesResponse*/, args/*: DebugProtocol.ScopesArguments*/) {
        const threadId = variableRefToThreadId(args.frameId);
        const thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Scopes',threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Scopes', threadId, response);

        const scopes = [new Scope("Local", args.frameId, false)];
		response.body = {
			scopes: scopes
		};

        const last_exception = thread.paused.last_exception;
        if (!last_exception || last_exception.objvar) {
            this.sendResponse(response);
            return;
        }

        // retrieve the exception object
        thread.allocateExceptionScopeReference(args.frameId);
        this.dbgr.getExceptionLocal(last_exception.exception)
            .then(ex_local => {
                last_exception.objvar = ex_local;
                let p = thread.getVariables(last_exception.scopeRef);
                if (!Array.isArray(p)) {
                    p = [p];
                }
                return Promise.all(p);
            })
            .then(() => {
                // put the exception first - otherwise it can get lost if there's a lot of locals
                scopes.unshift(new Scope("Exception: " + last_exception.objvar.type.typename, last_exception.scopeRef, false));
                this.sendResponse(response);
                // notify the exceptionInfo who may be waiting on us
                if (last_exception.waitForExObject) {
                    last_exception.waitForExObject();
                }
            })
            .catch((/*e*/) => {
                this.sendResponse(response);
            });
	}

    sourceRequest(response/*: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments*/) {
        const content = 
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
            const sources_path = path.join(process.env.ANDROID_HOME,'sources','android-'+this.dbgr.session.apilevel);
            fs.stat(sources_path, (err,stat) => {
                if (!err && stat && stat.isDirectory())
                    this._android_sources_path = sources_path;
            });
        }

        response.body = { content };
        this.sendResponse(response);
    }

	variablesRequest(response/*: DebugProtocol.VariablesResponse*/, args/*: DebugProtocol.VariablesArguments*/) {
        const threadId = variableRefToThreadId(args.variablesReference);
        const thread = this.getThread(threadId);
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
        const stepping_thread = this._threads.array.find(t => t && t.stepTimeout);
        const paused_threads = this._threads.array.filter(t => t && t.paused);
        const stopped_thread = paused_threads.find(t => t.paused.stoppedEvent);
        if (!stopped_thread && !stepping_thread && paused_threads.length) {
            // prioritise any stepped thread (if it's stopped) or whichever other thread stopped first
            let thread;
            const paused_step_thread = paused_threads.find(t => t.paused.reasons.includes("step"));
            if (paused_step_thread) {
                thread = paused_step_thread;
            } else {
                paused_threads.sort((a,b) => a.paused.when - b.paused.when);
                thread = paused_threads[0];
            }
            // if the break was due to a breakpoint and it has since been removed, just resume the thread
            if (thread.paused.reasons.length === 1 && thread.paused.reasons[0] === 'breakpoint') {
                const bp = this.dbgr.breakpoints.bysrcloc[thread.paused.location.qtype + ':' + thread.paused.location.linenum];
                if (!bp) {
                    this.doContinue(thread);
                    return;
                }
            }
            const event = new StoppedEvent(thread.paused.reasons[0], thread.vscode_threadid, thread.paused.last_exception && "Exception thrown");
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

        const t = this.getThread(args.threadId);
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

        const t = this.getThread(args.threadId);
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
        const last_exception = {
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
                        const ti = threadinfos[0], t = this.getThread(ti.threadid), event = new ThreadEvent();
                        t.name = ti.name;
                        event.body = { reason:'started', threadId: t.vscode_threadid };
                        this.sendEvent(event);
                    })
                    .catch(err => err)
                    .then(() => this.dbgr.resumethread(e.threadid));
                return;
            case 'end':
                const t = this._threads[e.threadid];
                if (t) {
                    if (t.stepTimeout) {
                        clearTimeout(t.stepTimeout);
                        t.stepTimeout = null;
                    }
                    delete this._threads[e.threadid];
                    delete this._threads.array[t.vscode_threadid];
                    const event = new ThreadEvent();
                    event.body = { reason:'exited', threadId: t.vscode_threadid };
                    this.sendEvent(event);
                    this.checkPendingThreadBreaks();    // in case we were stepping this thread
                }
                break;
        }
        this.dbgr.resumethread(e.threadid);
    }

    setVariableRequest(response/*: DebugProtocol.SetVariableResponse*/, args/*: DebugProtocol.SetVariableArguments*/) {

        const threadId = variableRefToThreadId(args.variablesReference);
        const thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Set variable', threadId, response);
        if (!thread.paused) return this.failRequestThreadNotSuspended('Set variable', threadId, response);

        thread.setVariableValue(args)
            .then(vsvar => {
                response.body = {
                    value: vsvar.value,
                    type: vsvar.type,
                    variablesReference: vsvar.variablesReference,
                };
            }, e => {
                response.success = false;
                response.message = e.message;
            })
            .then(() => {
                this.sendResponse(response);
            })
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
        const previdx = this._evals_queue.findIndex(e => e.args.expression === args.expression);
        if (previdx > 0) {
            // if we find a match, immediately fail the old one and queue the new one
            const prev = this._evals_queue.splice(previdx,1)[0];
            prev.response.success = false;
            prev.response.message = '(evaluating)';
            this.sendResponse(prev.response);
        }
        // if there's no frameId, we are being asked to evaluate the value in the 'global' context
        let getvars, thread;
        if (args.frameId) {
            const threadId = variableRefToThreadId(args.frameId);
            thread = this.getThread(threadId);
            if (!thread) return this.failRequestNoThread('Evaluate',threadId, response);
            if (!thread.paused) return this.failRequestThreadNotSuspended('Evaluate',threadId, response);
            getvars = thread._ensureLocals(args.frameId).then(frameId => {
                const locals = thread.paused.stack_frame_vars[frameId].locals;
                return {
                    locals: locals.variableHandles[frameId].cached,
                    vars: locals,
                }
            })
        } else {
            // global context - no locals
            getvars = Promise.resolve({});
        }

        this._evals_queue.push({
            response,
            args,
            getvars,
            thread,
        });

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
        const {response, args, getvars, thread} = this._evals_queue[0];

        // wait for any locals in the given context to be retrieved
        getvars.then(varinfo => {
                const {locals, vars} = varinfo;
                return evaluate(args.expression, thread, locals, vars, this.dbgr);
            })
            .then(({value,variablesReference}) => {
                response.body = { result:value, variablesReference:variablesReference|0 };
            })
            .catch(e => {
                response.success = false;
                response.message = e.message;
            })
            .then(() => {
                this.sendResponse(response);
                this._evals_queue.shift();
                this.doNextEvaluateRequest();
            })
    }

    exceptionInfoRequest(response /*DebugProtocol.ExceptionInfoResponse*/, args /**/) {
        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Exception info', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Exception info', args.threadId, response);
        if (!thread.paused.last_exception) return this.failRequest('No exception available', response);

        if (!thread.paused.last_exception.objvar || !thread.paused.last_exception.cached) {
            // we must wait for the exception object to be retreived as a local (along with the message field)
            if (!thread.paused.last_exception.waitForExObject) {
                thread.paused.last_exception.waitForExObject = () => {
                    thread.paused.last_exception.waitForExObject = null;
                    // redo the request
                    this.exceptionInfoRequest(response, args);
                }
            }
            return;
        }
        let exobj = thread.paused.last_exception.objvar;
        let exmsg = thread.paused.last_exception.cached.find(v => v.name === exmsg_var_name);
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