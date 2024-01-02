const {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, ThreadEvent, OutputEvent,
    Thread, StackFrame, Scope, Source, Breakpoint } = require('@vscode/debugadapter');

// node and external modules
const os = require('os');
const path = require('path');

// our stuff
const { ADBClient } = require('./adbclient');
const { APKFileInfo } = require('./apk-file-info');
const { Debugger } = require('./debugger');
const { AttachBuildInfo, BreakpointOptions, DebuggerException, JavaClassType, LaunchBuildInfo } = require('./debugger-types');
const { evaluate } = require('./expression/evaluate');
const { PackageInfo } = require('./package-searcher');
const ADBSocket = require('./sockets/adbsocket');
const { AndroidThread } = require('./threads');
const { checkADBStarted, getAndroidSourcesFolder } = require('./utils/android');
const { D, initLogToClient, onMessagePrint } = require('./utils/print');
const { hasValidSourceFileExtension } = require('./utils/source-file');
const analytics = require('../langserver/analytics');

/**
 * @typedef {import('./debugger-types').DebuggerValue} DebuggerValue
 * @typedef {import('./debugger-types').JavaBreakpointEvent} JavaBreakpointEvent
 * @typedef {import('./debugger-types').JavaExceptionEvent} JavaExceptionEvent
 * @typedef {import('./debugger-types').SourceLocation} SourceLocation
 * @typedef {import('./variable-manager').VariableManager} VariableManager
 */

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
        // packages we found in the source tree
        this.src_packages = {
            last_src_modified: 0,
            /** @type {Map<string,PackageInfo>} */
            packages: new Map(),
        };
        // the device we are debugging
        this._device = null;
        // the API level of the device we are debugging
        this.device_api_level = '';


        // the full file path name of the AndroidManifest.xml, taken from the manifestFile launch property
        this.manifest_fpn = '';
        // the filepathname of the built apk
        this.apk_fpn = '';
        /**
         * the file info, hash and manifest data of the apk
         * @type {APKFileInfo}
        */
        this.apk_file_info = null;

        /**
         * array of custom arguments to pass to `pm install`
         * @type {string[]}
         */
        this.pm_install_args = null;

        /**
         * array of custom arguments to pass to `am start`
         * @type {string[]}
         */
        this.am_start_args = null;

        /**
         * the threads (from the last refreshThreads() call)
         * @type {AndroidThread[]}
         */
        this._threads = []

        // path to the the ANDROID_HOME/sources/<api> (only set if it's a valid path)
        this._android_sources_path = '';

        // number of call stack entries to display above the project source
        this.callStackDisplaySize = 0;

        /**
         * the fifo queue of evaluations (watches, hover, etc)
         * @type {EvalQueueEntry[]}
         */
        this._evals_queue = [];

        // since we want to send breakpoint events, we will assign an id to every event
        // so that the frontend can match events with breakpoints.
        this._breakpointId = 1000;
        // the fifo queue of breakpoints to enable
        this._set_breakpoints_queue = [];

        this._sourceRefs = { all:[null] };  // hashmap + array of (non-zero) source references

        // flag to distinguish unexpected disconnection events (initiated from the device) vs user-terminated requests
        this._isDisconnecting = false;

        // trace flag for printing diagnostic messages to the client Output Window
        this.trace = false;

        // set to true if we've connected to the device
        this.debuggerAttached = false;

        /**
         * @type {'launch'|'attach'}
         */
        this.debug_mode = null;

        this.terminate_reason = '';

        this.session_start = new Date();
        analytics.init(undefined, undefined, undefined, '', require('../package.json'), {}, 'debugger-start');

        // this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        // override the log function to output to the client Debug Console
        initLogToClient(this.LOG.bind(this));
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
     * @param {import('@vscode/debugprotocol').DebugProtocol.InitializeResponse} response
	 */
	initializeRequest(response) {
        response.body.exceptionBreakpointFilters = [
            { label:'All Exceptions', filter:'all', default:false },
            { label:'Uncaught Exceptions', filter:'uncaught', default:true },
        ];
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsSetVariable = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsExceptionInfoRequest = true;
        response.body.supportsHitConditionalBreakpoints = true;

        this.sendResponse(response);
    }

    /**
     * @param {string} msg 
     */
    LOG(msg) {
        if (!this.trace) {
            D(msg);
        }
        // VSCode no longer auto-newlines output
        this.sendEvent(new OutputEvent(`${msg}${os.EOL}`));
    }

    /**
     * @param {string} msg 
     */
    WARN(msg) {
        D(msg = `Warning: ${msg}`);
        // the message will already be sent if trace is enabled
        if (this.trace) {
            return;
        }
        this.sendEvent(new OutputEvent(`${msg}${os.EOL}`));
    }

    /**
     * @param {string} msg 
     * @param {import('@vscode/debugprotocol').DebugProtocol.Response} response
     * @param {boolean} silent
     */
    failRequest(msg, response, silent = false) {
        // yeah, it can happen sometimes...
        if (silent) {
            D(msg); // just log it in debug - don't output it to the client
        } else if (msg) {
            this.WARN(msg);
        }
        if (response) {
            response.success = false;
            this.sendResponse(response);
        }
    }

    /**
     * @param {string} requestName 
     * @param {number} threadId 
     * @param {import('@vscode/debugprotocol').DebugProtocol.Response} response
     */
    failRequestNoThread(requestName, threadId, response) {
        this.failRequest(`${requestName} failed. Thread ${threadId} not found`, response);
    }

    /**
     * @param {string} requestName 
     * @param {number} threadId 
     * @param {import('@vscode/debugprotocol').DebugProtocol.Response} response
     */
    failRequestThreadNotSuspended(requestName, threadId, response) {
        this.failRequest(`${requestName} failed. Thread ${threadId} is not suspended`, response);
    }

    /**
     * @param {string} requestName 
     * @param {number} threadId 
     * @param {import('@vscode/debugprotocol').DebugProtocol.Response} response
     */
    cancelRequestThreadNotSuspended(requestName, threadId, response) {
        // now that vscode can resume threads before the locals,callstack,etc are retrieved, we only need to cancel the request
        this.failRequest(`${requestName} cancelled. Thread ${threadId} is not suspended`, response, true);
    }

    /**
     * @param {JavaThreadID|VSCThreadID} id
     * @param {string} [name]
     */
    getThread(id, name) {
        let thread;
        switch(typeof id) {
            case 'string': 
                thread = this._threads.find(t => t && t.threadid === id);
                if (!thread) {
                    thread = new AndroidThread(this.dbgr, name, id);
                    this._threads[thread.vscode_threadid] = thread;
                }
                break;
            case 'number': 
                thread = this._threads[id];
                break;
        }
        return thread;
    }

    /**
     * 
     * @param {'breakpoint'|'step'|'exception'} reason 
     * @param {SourceLocation} location 
     * @param {DebuggerException} [last_exception] 
     */
    reportStoppedEvent(reason, location, last_exception = null) {
        const thread = this.getThread(location.threadid);
        if (thread.paused) {
            // this thread is already in the paused state - ignore the notification
            thread.paused.reasons.push(reason);
            if (last_exception) {
                thread.paused.last_exception = last_exception;
            }
            return;
        }
        thread.setPaused(reason, location, last_exception); 
        this.checkPendingThreadBreaks();
    }

    async refreshThreads() {
        const thread_ids = await this.dbgr.getJavaThreadIDs();
        const threadinfos = await this.dbgr.getJavaThreadInfos(thread_ids);

        // configure the thread names
        threadinfos.forEach(threadinfo => {
            const thread = this.getThread(threadinfo.threadid);
            if (typeof thread.name !== 'string') {
                thread.name = threadinfo.name;
            } else if (thread.name !== threadinfo.name) {
                // give the thread a new id for VS code
                // - note: this will invalidate all current variable references for this thread
                delete this._threads[thread.vscode_threadid];
                thread.allocateNewThreadID();
                this._threads[thread.vscode_threadid] = thread;
                thread.name = threadinfo.name;
            }
        });

        // remove any threads that are no longer in the system
        this._threads.slice().forEach(thread => {
            if (thread) {
                const exists = threadinfos.find(ti => ti.threadid === thread.threadid);
                if (!exists) {
                    delete this._threads[thread.vscode_threadid];
                }
            }
        })
    }

    /**
     * @param {*} obj 
     */
    extractPidAndTargetDevice(obj) {
        let x, pid, serial = '', status;
        try {
            x = JSON.parse(`${obj}`);
        } catch {
        }
        if (typeof x === 'number') {
            pid = x;
        } else if (typeof x === 'object') {
            // object passed from PickAndroidProcess in the extension
            ({ pid, serial, status } = x);
            if (status !== 'ok') {
                return null;
            }
        }
        if (typeof pid !== "number" || (pid < 0)) {
            this.LOG(`Attach failed: "processId" property in launch.json is not valid`);
            return null;
        }
        return {
            processId: pid,
            targetDevice: `${serial}`,
        }
    }

    extractTargetDeviceID(s) {
        if (!s || typeof s !== 'string') {
            return '';
        }
        // the device picker returns a stringified object
        try {
            const o = JSON.parse(s);
            return o.serial || s;
        } catch {
        }
        return s;
    }

    /**
     * @typedef AndroidAttachArguments
     * @property {number} adbPort
     * @property {string} adbSocket
     * @property {string} appSrcRoot
     * @property {boolean} autoStartADB
     * @property {number} jdwpPort
     * @property {number} processId
     * @property {string} targetDevice
     * @property {boolean} trace
     * 
     * @param {import('@vscode/debugprotocol').DebugProtocol.AttachResponse} response 
     * @param {import('@vscode/debugprotocol').DebugProtocol.AttachRequestArguments & AndroidAttachArguments} args 
     */
	async attachRequest(response, args) {
        this.debug_mode = 'attach';
        if (args && args.trace) {
            this.trace = args.trace;
            onMessagePrint(this.LOG.bind(this));
        }
        D(JSON.stringify({type: 'attach', args, env:process.env}, null, ' '));

        if (args.targetDevice === 'null') {
            // "null" is returned from the device picker if there's an error or if the
            // user cancels.
            D('targetDevice === "null"');
            this.terminate_reason = "null-targetdevice";
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        if (!args.processId) {
            this.LOG(`Attach failed: Missing "processId" property in launch.json`);
            this.terminate_reason = "no-processid";
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        // the processId passed in args can be:
        // - a fixed id defined in launch.json (should be a string, but we allow a number),
        // - a JSON object returned from the process picker (contains the target device and process ID),
        let attach_info = this.extractPidAndTargetDevice(args.processId);
        if (!attach_info) {
            this.terminate_reason = "null-attachinfo";
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        // set the custom ADB host and port
        if (typeof args.adbSocket === 'string' && args.adbSocket) {
            ADBSocket.HostPort = args.adbSocket;
        } else if (typeof args.adbPort === 'number' && args.adbPort >= 0 && args.adbPort <= 65535) {
            ADBSocket.HostPort = `:${args.adbPort}`;
        }

        // set the fixed JDWP port number (if any)
        if (typeof args.jdwpPort === 'number' && args.jdwpPort >= 0 && args.jdwpPort <= 65535) {
            Debugger.portManager.fixedport = args.jdwpPort;
        }

        try {
            // app_src_root must end in a path-separator for correct validation of sub-paths
            this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
            // start by scanning the source folder for stuff we need to know about (packages, manifest, etc)
            this.src_packages = PackageInfo.scanSourceSync(this.app_src_root);
            // warn if we couldn't find any packages (-> no source -> cannot debug anything)
            if (this.src_packages.packages.size === 0)
                this.WARN('No source files found. Check the "appSrcRoot" setting in launch.json');

        } catch(err) {
            // wow, we really didn't make it very far...
            this.LOG(err.message);
            this.LOG('Check the "appSrcRoot" entries in launch.json');
            this.terminate_reason = `init-exception: ${err.message}`;
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        try {
            let { processId, targetDevice } = attach_info;
            if (!targetDevice) {
                targetDevice = this.extractTargetDeviceID(args.targetDevice);
            }
            // make sure ADB exists and is started and look for a connected device
            await checkADBStarted(args.autoStartADB !== false);
            this._device = await this.findSuitableDevice(targetDevice, args.trace);
            this._device.adbclient = new ADBClient(this._device.serial);

            // try and determine the relevant path for the API sources (based upon the API level of the connected device)
            await this.configureAPISourcePath();

            const build = new AttachBuildInfo(new Map(this.src_packages.packages));
            this.LOG(`Attaching to pid ${processId} on device ${this._device.serial} [API:${this.device_api_level||'?'}]`);

            // try and attach to the specified pid
            await this.dbgr.attachToProcess(build, processId, this._device.serial);

            this.debuggerAttached = true;

            // if we get this far, the debugger is connected and waiting for the resume command
            // - set up some events...
            this.dbgr.on('bpstatechange', e => this.onBreakpointStateChange(e))
                .on('bphit', e => this.onBreakpointHit(e))
                .on('step', e => this.onStep(e))
                .on('exception', e => this.onException(e))
                .on('threadchange', e => this.onThreadChange(e))
                .on('disconnect', () => this.onDebuggerDisconnect());

            // - tell the client we're initialised and ready for breakpoint info, etc
            this.sendEvent(new InitializedEvent());
            await new Promise(resolve => this.waitForConfigurationDone = resolve);

            // get the debugger to tell us about any thread creations/terminations
            await this.dbgr.setThreadNotify();

            // config is done - we're all set and ready to go!
            this.sendResponse(response);

            this.LOG(`Debugger attached`);
            await this.dbgr.resume();
            
            analytics.event('debug-started', {
                dbg_start: this.session_start.toTimeString(),
                dbg_tz: this.session_start.getTimezoneOffset(),
                dbg_kind: 'attach',
                dbg_device_api: this.device_api_level,
                dbg_emulator: /^emulator/.test(this._device.serial),
            })
        } catch(e) {
            const msg = e.message||e.msg;
            //this.performDisconnect();
            // exceptions use message, adbclient uses msg
            this.LOG('Attach failed: '+(msg||'No additional information is available'));
            // more info for adb connect errors
            if (/^ADB server is not running/.test(e.msg)) {
                this.LOG('Make sure the Android SDK Platform Tools are installed and run:');
                this.LOG('      adb start-server');
                this.LOG('If you are running ADB using a non-default configuration, also make sure the adbSocket value in your launch.json is correct.');
            }
            if (/ADB|JDWP/.test(msg)) {
                this.LOG('Ensure any instances of Android Studio are closed and ADB is running.');
            }
            // tell the client we're done
            this.terminate_reason = `start-exception: ${msg}`;
            this.sendEvent(new TerminatedEvent(false));
        }
    }

    /**
     * @typedef AndroidLaunchArguments
     * @property {number} adbPort
     * @property {string} adbSocket
     * @property {string[]} amStartArgs 
     * @property {string} apkFile
     * @property {string} appSrcRoot
     * @property {boolean} autoStartADB
     * @property {number} callStackDisplaySize
     * @property {number} jdwpPort
     * @property {string} launchActivity
     * @property {string} manifestFile
     * @property {string[]} pmInstallArgs
     * @property {number} postLaunchPause
     * @property {number} processId
     * @property {StaleBuildSetting} staleBuild
     * @property {string} targetDevice
     * @property {boolean} trace

     * The entry point to the debugger
     * @param {import('@vscode/debugprotocol').DebugProtocol.LaunchResponse} response 
     * @param {import('@vscode/debugprotocol').DebugProtocol.LaunchRequestArguments & AndroidLaunchArguments} args 
     */
	async launchRequest(response, args) {
        this.debug_mode = 'launch';
        if (args && args.trace) {
            this.trace = args.trace;
            onMessagePrint(this.LOG.bind(this));
        }
        D(JSON.stringify({type: 'launch', args, env:process.env}, null, ' '));

        if (args.targetDevice === 'null') {
            // "null" is returned from the device picker if there's an error or if the
            // user cancels.
            D('targetDevice === "null"');
            this.terminate_reason = "null-targetdevice";
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        // app_src_root must end in a path-separator for correct validation of sub-paths
        this.app_src_root = ensure_path_end_slash(args.appSrcRoot);
        this.apk_fpn = args.apkFile;
        this.manifest_fpn = args.manifestFile;
        this.pm_install_args = args.pmInstallArgs;
        this.am_start_args = args.amStartArgs;
        if (typeof args.callStackDisplaySize === 'number' && args.callStackDisplaySize >= 0)
            this.callStackDisplaySize = args.callStackDisplaySize|0;

        // we don't allow both amStartArgs and launchActivity to be specified (the launch activity must be included in amStartArgs)
        if (args.amStartArgs && args.launchActivity) {
            this.LOG('amStartArgs and launchActivity options cannot both be specified in the launch configuration.');
            this.terminate_reason = "amStartArgs+launchActivity";
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        // set the custom ADB host and port
        if (typeof args.adbSocket === 'string' && args.adbSocket) {
            ADBSocket.HostPort = args.adbSocket;
        } else if (typeof args.adbPort === 'number' && args.adbPort >= 0 && args.adbPort <= 65535) {
            ADBSocket.HostPort = `:${args.adbPort}`;
        }

        // set the fixed JDWP port number (if any)
        if (typeof args.jdwpPort === 'number' && args.jdwpPort >= 0 && args.jdwpPort <= 65535) {
            Debugger.portManager.fixedport = args.jdwpPort;
        }

        try {
            // start by scanning the source folder for stuff we need to know about (packages, manifest, etc)
            this.src_packages = PackageInfo.scanSourceSync(this.app_src_root);
            // warn if we couldn't find any packages (-> no source -> cannot debug anything)
            if (this.src_packages.packages.size === 0)
                this.WARN('No source files found. Check the "appSrcRoot" setting in launch.json');

        } catch(err) {
            // wow, we really didn't make it very far...
            this.LOG(err.message);
            this.LOG('Check the "appSrcRoot" and "apkFile" entries in launch.json');
            this.terminate_reason = `init-exception: ${err.message}`;
            this.sendEvent(new TerminatedEvent(false));
            return;
        }

        try {
            this.LOG('Checking build')
            this.apk_file_info = await APKFileInfo.from(args);
            this.checkBuildIsUpToDate(args.staleBuild);

            // check we have something to launch - we do this again later, but it's a bit better to do it before we start device comms
            let launchActivity = args.launchActivity;
            if (!launchActivity)
                if (!(launchActivity = this.apk_file_info.manifest.launcher))
                    throw new Error('No valid launch activity found in AndroidManifest.xml or launch.json');

            // make sure ADB exists and is started and look for a device to install on
            await checkADBStarted(args.autoStartADB !== false);
            const targetDevice = this.extractTargetDeviceID(args.targetDevice);
            this._device = await this.findSuitableDevice(targetDevice, true);
            this._device.adbclient = new ADBClient(this._device.serial);

            // install the APK we are going to debug
            await this.ensureAPKInstalled();

            // when we reach here, the app should be installed and ready to be launched
            // - we no longer need the APK file data
            this.apk_file_info.file_data = null;

            // try and determine the relevant path for the API sources (based upon the API level of the connected device)
            await this.configureAPISourcePath();

            // launch the app
            await this.startLaunchActivity(args.launchActivity, args.postLaunchPause);

            this.debuggerAttached = true;

            // if we get this far, the debugger is connected and waiting for the resume command
            // - set up some events...
            this.dbgr.on('bpstatechange', e => this.onBreakpointStateChange(e))
                .on('bphit', e => this.onBreakpointHit(e))
                .on('step', e => this.onStep(e))
                .on('exception', e => this.onException(e))
                .on('threadchange', e => this.onThreadChange(e))
                .on('disconnect', () => this.onDebuggerDisconnect());

            // - tell the client we're initialised and ready for breakpoint info, etc
            this.sendEvent(new InitializedEvent());
            await new Promise(resolve => this.waitForConfigurationDone = resolve);

            // get the debugger to tell us about any thread creations/terminations
            await this.dbgr.setThreadNotify();

            // config is done - we're all set and ready to go!
            D('Continuing app start');
            this.sendResponse(response);
            await this.dbgr.resume();
            
            analytics.event('debug-started', {
                dbg_start: this.session_start.toTimeString(),
                dbg_tz: this.session_start.getTimezoneOffset(),
                dbg_kind: 'debug',
                dbg_device_api: this.device_api_level,
                dbg_emulator: /^emulator/.test(this._device.serial),
                dbg_apk_size: this.apk_file_info.file_size,
                dbg_pkg_name: this.apk_file_info.manifest.package || '',
            })

            this.LOG('Application started');
        } catch(e) {
            const msg = e.message || e.msg;
            // exceptions use message, adbclient uses msg
            this.LOG('Launch failed: '+(msg || 'No additional information is available'));
            // more info for adb connect errors
            if (/^ADB server is not running/.test(e.msg)) {
                this.LOG('Make sure the Android SDK Platform Tools are installed and run:');
                this.LOG('      adb start-server');
                this.LOG('If you are running ADB on a non-default port, also make sure the adbPort value in your launch.json is correct.');
            }
            if (/ADB|JDWP/.test(msg)) {
                this.LOG('Ensure any instances of Android Studio are closed.');
            }
            // tell the client we're done
            this.terminate_reason = `start-exception: ${msg}`;
            this.sendEvent(new TerminatedEvent(false));
        }
    }
    
    /**
     * Check if the build is out of date (i.e a source file has been modified since the last build)
     * @param {StaleBuildSetting} staleBuild 
     */
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

    /**
     * 
     * @param {string} launchActivity 
     * @param {number} postLaunchPause 
     */
    async startLaunchActivity(launchActivity, postLaunchPause) {
        if (!launchActivity) {
            // we're allowed no launchActivity if we have a custom am start command
            if (!this.am_start_args) {
                if (!(launchActivity = this.apk_file_info.manifest.launcher)) {
                    throw new Error('No valid launch activity found in AndroidManifest.xml or launch.json');
                }
            }
        }

        const build = new LaunchBuildInfo(
            new Map(this.src_packages.packages),
            this.apk_file_info.manifest.package,
            launchActivity,
            this.am_start_args,
            postLaunchPause);

        this.LOG(`Launching on device ${this._device.serial} [API:${this.device_api_level||'?'}]`);
        if (this.am_start_args) {
            this.LOG(`Using custom launch arguments '${this.am_start_args.join(' ')}'`);
        }
        const am_stdout = await this.dbgr.startDebugSession(build, this._device.serial);
        this.LOG(am_stdout);
    }

    async configureAPISourcePath() {
        const apilevel = await this.getDeviceAPILevel();

        // look for the android sources folder appropriate for this device
        this._android_sources_path = getAndroidSourcesFolder(apilevel, true);
    }

    async getDeviceAPILevel() {
        const apilevel = await this._device.adbclient.shell_cmd({command:'getprop ro.build.version.sdk'});
        this.device_api_level = apilevel.trim();
        return this.device_api_level;
    }
    
    async ensureAPKInstalled() {
        const installed = await this.isAPKInstalled();
        if (installed) {
            this.LOG('Current build already installed');
            return;
        }
        await this.copyAndInstallAPK();
    }

    async isAPKInstalled() {
        // retrieve the hash of the installed app (or sha1 utility itself if the app is not installed)
        const query_app_hash = `/system/bin/sha1sum $(pm path ${this.apk_file_info.manifest.package}|grep -o -e '/.*' || echo '/system/bin/sha1sum')`;
        const sha1sum_output = await this._device.adbclient.shell_cmd({command: query_app_hash});
        const installed_hash = sha1sum_output.match(/^[0-9a-fA-F]*/)[0].toLowerCase();

        // does the installed apk hash match the content hash? if, so we don't need to install the app
        return installed_hash === this.apk_file_info.content_hash;
    }

    async copyAndInstallAPK() {
        // copy the file to the device
        this.LOG('Deploying current build...');
        const device_apk_fpn = '/data/local/tmp/debug.apk';
        await this._device.adbclient.push_file({
            pathname: device_apk_fpn,
            data: this.apk_file_info.file_data,
            mtime: (Date.now() / 1000) | 0,
            perms: 0o100664,
        })
        // send the install command
        this.LOG('Installing...');
        const pm_install_args = Array.isArray(this.pm_install_args) ? this.pm_install_args.join(' ') : '-r';
        const command = `pm install ${pm_install_args} ${device_apk_fpn}`;
        D(command);
        const stdout = await this._device.adbclient.shell_cmd({
            command,
        })
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
    }

    /**
     * @param {string} target_deviceid 
     * @param {boolean} show_progress
     */
    async findSuitableDevice(target_deviceid, show_progress) {
        show_progress && this.LOG('Searching for devices...');
        const devices = await this.dbgr.listConnectedDevices()
        show_progress && this.LOG(`Found ${devices.length} device${devices.length===1?'':'s'}`);

        let reject;
        if (devices.length === 0) {
            reject = 'No devices are connected';
        } else if (target_deviceid) {
            // check (only one of) the requested device is present
            const matching_devices = devices.filter(d => d.serial === target_deviceid);
            switch(matching_devices.length) {
                case 0:
                    reject = `Target device: '${target_deviceid}' is not connected. Connect it or specify an alternate target device in launch.json`;
                    break;
                case 1:
                    return matching_devices[0];
                default:
                    reject = `Target device: '${target_deviceid}' has multiple candidates. Connect a single device or specify an alternate target device in launch.json`;
                    break;
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
    }

    /**
     * 
     * @param {import('@vscode/debugprotocol').DebugProtocol.ConfigurationDoneResponse} response 
     */
    configurationDoneRequest(response) {
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

    /**
     * 
     * @param {import('@vscode/debugprotocol').DebugProtocol.DisconnectResponse} response 
     */
    async disconnectRequest(response) {
        D('disconnectRequest');
        this._isDisconnecting = true;
        analytics.event('debug-end', {
            dbg_elapsed: Math.trunc((Date.now() - this.session_start.getTime())/1e3),
            dbg_kind: this.debug_mode,
            dbg_term_reason: this.terminate_reason,
        });
        if (this.debuggerAttached) {
            try {
                if (this.debug_mode === 'launch') {
                    await this.dbgr.forceStop();
                    this.LOG(`Debugger stopped`);
                } else {
                    await this.dbgr.disconnect();
                    this.LOG(`Debugger detached`);
                }
            } catch (e) {
            }
        }
        this.sendResponse(response);
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

    /**
     * Called by the debugger in response to a JDWP breakpoint hit event
     * @param {JavaBreakpointEvent} e 
     */
    onBreakpointHit(e) {
        // if we step into a breakpoint, both onBreakpointHit and onStep will be called
        D(`Breakpoint hit: ${e.stoppedLocation}`);
        this.reportStoppedEvent("breakpoint", e.stoppedLocation);
    }

    /**
     * Called when the user requests a change to breakpoints in a source file
     * Note: all breakpoints in a file are always sent in args, even if they are not changing
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetBreakpointsResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetBreakpointsArguments} args
     */
	async setBreakPointsRequest(response, args) {
		const source_filename = args.source && args.source.path;
        D('setBreakPointsRequest: ' + source_filename);

        const unverified_breakpoint = (src_bp,reason) => {
            const bp = new Breakpoint(false, src_bp.line);
            bp['id'] = ++this._breakpointId;
            bp['message'] = reason;
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
        const srcfolder = path.dirname(source_filename);
        const package_infos = [...this.src_packages.packages.values()];
        let pkginfo = package_infos.find(pi => pi.package_path === srcfolder);

        // if we didn't find an exact path match, look for a case-insensitive match
        if (!pkginfo) {
            pkginfo = package_infos.find(pi => pi.package_path.localeCompare(srcfolder, undefined, { sensitivity: 'base' }) === 0);
        }

        // if it's not in our source packages, check if it's in the Android source file cache
        if (!pkginfo && is_subpath_of(source_filename, this._android_sources_path)) {
            // create a fake pkginfo to use to construct the bp
            pkginfo = new PackageInfo(this._android_sources_path, '', [], '', '');
        }
        if (!pkginfo || !hasValidSourceFileExtension(source_filename)) {
            // source file is not a java file or is outside of the known source packages
            // just send back a list of unverified breakpoints
            sendBPResponse(response, args.breakpoints.map(bp => unverified_breakpoint(bp, 'The breakpoint location is not valid')));
            return;
        }

        // our debugger requires a relative fpn beginning with / , rooted at the java source base folder
        // - it should look like: /some/package/name/abc.java
        const relative_fpn = source_filename.slice(pkginfo.srcroot.match(/^(.*?)[\\/]?$/)[1].length).replace(/\\/g,'/');

        // delete any existing breakpoints not in the list
        const src_line_nums = args.breakpoints.map(bp => bp.line);
        const deleted_breakpoints = this.dbgr.findBreakpoints(
            javabp => (javabp.srcfpn === relative_fpn) && !src_line_nums.includes(javabp.linenum)
        );
        deleted_breakpoints.forEach(bp => bp.vsbp = null);
        this.dbgr.removeBreakpoints(deleted_breakpoints);

        // setting a debugger bp is now asynchronous, so we do this as an orderly queue
        const bp_queue_len = this._set_breakpoints_queue.push({args,response,relative_fpn});
        if (bp_queue_len === 1) {
            do {
                const { args, relative_fpn, response } = this._set_breakpoints_queue[0];
                const javabp_arr = await this.setupBreakpointsInFile(args.breakpoints, relative_fpn);
                // send back the VS Breakpoint instances
                sendBPResponse(response, javabp_arr.map(javabp => javabp.vsbp));
                // .. and do the next one
                this._set_breakpoints_queue.shift();
            } while (this._set_breakpoints_queue.length);
        }
	}

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.SourceBreakpoint[]} breakpoints 
     * @param {string} relative_fpn 
     */
    async setupBreakpointsInFile(breakpoints, relative_fpn) {
        const java_breakpoints = [];
        for (let idx = 0; idx < breakpoints.length; idx++) {
            const src_bp = breakpoints[idx];
            const dbgline = this.convertClientLineToDebugger(src_bp.line);
            const options = new BreakpointOptions(); 
            if (src_bp.hitCondition) {
                // the hit condition is an expression that requires evaluation
                // until we get more comprehensive evaluation support, just allow integer literals
                const m = src_bp.hitCondition.match(/^\s*(?:0x([0-9a-f]+)|0b([01]+)|0*(\d+([e]\+?\d+)?))\s*$/i);
                if (m) {
                    const hitcount = m[3] ? parseFloat(m[3]) : m[2] ? parseInt(m[2],2) : parseInt(m[1],16);
                    if ((hitcount > 0) && (hitcount <= 0x7fffffff)) {
                        options.hitcount = hitcount;
                    }
                }
            }
            const javabp = await this.dbgr.setBreakpoint(relative_fpn, dbgline, options);
            if (!javabp.vsbp) {
                // state is one of: set,notloaded,enabled,removed
                const verified = !!javabp.state.match(/set|enabled/);
                const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(dbgline));
                // the breakpoint *must* have an id field or it won't update properly
                bp['id'] = ++this._breakpointId;
                if (javabp.state === 'notloaded')
                    bp['message'] = 'The runtime hasn\'t loaded this code location';
                javabp.vsbp = bp;
            }
            javabp.vsbp.order = idx;
            java_breakpoints.push(javabp);
        }
        return java_breakpoints;
    };

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetExceptionBreakpointsResponse} response 
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetExceptionBreakpointsArguments} args 
     */
    async setExceptionBreakPointsRequest(response, args) {
        await this.dbgr.clearBreakOnExceptions();
        switch(true) {
            case args.filters.includes('all'):
                await this.dbgr.setBreakOnExceptions('both');
                break;
            case args.filters.includes('uncaught'):
                await this.dbgr.setBreakOnExceptions('uncaught');
                break;
        }
        this.sendResponse(response);
    }

    /**
     * 
     * @param {import('@vscode/debugprotocol').DebugProtocol.ThreadsResponse} response 
     */
	async threadsRequest(response) {
        if (!this._threads.length) {
            try {
                await this.refreshThreads();
            } catch (e) {
                response.success = false;
                this.sendResponse(response);
                return;
            }
        }
        D('threadsRequest: ' + this._threads.length);
        response.body = {
            threads: this._threads
                .filter(x => x)
                .map(t => {
                    const javaid = parseInt(t.threadid, 16);
                    return new Thread(t.vscode_threadid, `Thread (id:${javaid}) ${t.name||'<unnamed>'}`);
                })
        };
        this.sendResponse(response);
    }

	/**
	 * Returns a stack trace for the given threadId
     * @param {import('@vscode/debugprotocol').DebugProtocol.StackTraceResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.StackTraceArguments} args
	 */
	async stackTraceRequest(response, args) {
        D(`stackTraceRequest thread:${args.threadId}`);
        // only retrieve the stack if the thread is paused
        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Stack trace', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Stack trace', args.threadId, response);

        try {
            // retrieve the (stack) frames from the debugger
            const frames = await this.dbgr.getFrames(thread.threadid);
            // ensure that the line-tables for all the methods are loaded
            await Promise.all(frames.map(f => this.dbgr._ensureMethodLines(f.method)));

            const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
            const maxLevels = typeof args.levels === 'number' ? args.levels : frames.length-startFrame;
            const endFrame = Math.min(startFrame + maxLevels, frames.length);
            let stack = [];
            let totalFrames = frames.length;
            let highest_known_source = 0;
            const android_src_path = this._android_sources_path || '{Android SDK}';
            for (let i = startFrame; (i < endFrame) && thread.paused; i++) {
                // the stack_frame_id must be unique across all threads
                const stack_frame = thread.createStackFrameVariable(frames[i], i);
                const name = `${frames[i].method.owningclass.name}.${frames[i].method.name}`;
                const type = frames[i].method.owningclass.type;
                if (!(type instanceof JavaClassType)) {
                    totalFrames--;
                    continue;   // sanity check - the call stack must be in a class type
                }
                const pkginfo = this.src_packages.packages.get(type.package);
                const srcloc = this.dbgr.frameToSourceLocation(frames[i]);
                if (!srcloc && !pkginfo) {
                    totalFrames--;
                    continue;  // ignore frames which have no location (they're probably synthetic)
                }
                const linenum = srcloc && this.convertDebuggerLineToClient(srcloc.linenum);
                const sourcefile = frames[i].method.owningclass.src.sourcefile || (type.signature.match(/([^\/$]+)[;$]/)[1]+'.java');
                let srcRefId = 0;
                let srcInfo;
                if (!pkginfo) {
                    const sig = type.signature;
                    srcInfo = this._sourceRefs[sig];
                    if (!srcInfo) {
                        this._sourceRefs.all.push(srcInfo = { 
                            id: this._sourceRefs.all.length, 
                            signature:sig,
                            filepath:path.join(android_src_path,type.package.replace(/[.]/g,path.sep), sourcefile),
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
                stack.push(new StackFrame(stack_frame.variableReference, name, src, linenum, colnum));
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
        } catch(e) {
            return this.failRequest('No call stack is available', response);
        }
	}

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.ScopesResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.ScopesArguments} args
     */
	async scopesRequest(response, args) {
        D(`scopesRequest frame:${args.frameId}`);
        const threadId = AndroidThread.variableRefToThreadId(args.frameId);
        const thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Scopes',threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Scopes', threadId, response);

        const scopes = [new Scope("Local", args.frameId, false)];
		response.body = {
			scopes,
		};

        const last_exception = thread.paused.last_exception;
        if (!last_exception) {
            this.sendResponse(response);
            return;
        }

        try {
            last_exception.scopeRef = args.frameId + 1;
            const scope = new Scope(`Exception: ${last_exception.exceptionValue.type.typename}`, last_exception.scopeRef, false);
            // put the exception first - otherwise it can get lost if there's a lot of locals
            scopes.unshift(scope);
        } catch(e) {
        }
        this.sendResponse(response);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.SourceResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.SourceArguments} args
     */
    sourceRequest(response, args) {
        D(`sourceRequest: ${args.sourceReference}`);
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
        this._android_sources_path = getAndroidSourcesFolder(this.device_api_level, true);

        response.body = { content };
        this.sendResponse(response);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.VariablesResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.VariablesArguments} args
     */
	async variablesRequest(response, args) {
        D(`variablesRequest variablesReference:${args.variablesReference}`);
        const threadId = AndroidThread.variableRefToThreadId(args.variablesReference);
        const thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Variables',threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Variables',threadId, response);

        let variables = [];
        const stack_frame = thread.findStackFrame(args.variablesReference);
        const vref = args.variablesReference % 1e6;
        switch(vref) {
            case 0: // frame scope reference
            case 1: // exception scope reference
                variables = await stack_frame.getLocalVariables();
                if (vref === 1) {
                    variables = [stack_frame.makeVariableValue(thread.paused.last_exception.exceptionValue)];
                    variables = await stack_frame.getExpandableValues(variables[0].variablesReference);
                }
                break;
            default: {
                // variable reference for an expandable entry
                variables = await stack_frame.getExpandableValues(args.variablesReference);
                break;
            }
        }
        response.body = {
            variables,
        };
        this.sendResponse(response);
	}

    /**
     * Choose a stopped thread to show in VSCode.
     * This function prioritises multiple stopped threads.
     */
    checkPendingThreadBreaks() {
        // threads that are currently mid-step
        const stepping_thread = this._threads.find(t => t && t.stepTimeout);
        // threads that are currently paused
        const paused_threads = this._threads.filter(t => t && t.paused);
        // paused threads that we've notified VSCode about
        const stopped_thread = paused_threads.find(t => t.paused.stoppedEvent);
        if (stopped_thread || stepping_thread || !paused_threads.length) {
            // we already have a stopped thread, or
            // we are waiting for the stepping thread to complete its step, or
            // there are no paused threads (i.e all threads are currently running)
            return;
        }

        // prioritise any stepped thread (if it's stopped) - this allows the user to step through
        // code without bouncing between different threads
        let thread;
        const paused_step_thread = paused_threads.find(t => t.paused.reasons.includes("step"));
        if (paused_step_thread) {
            thread = paused_step_thread;
        } else {
            // if there's no paused step thread, choose the earliest paused thread
            paused_threads.sort((a,b) => a.paused.when - b.paused.when);
            thread = paused_threads[0];
        }
        // if the break was due to a breakpoint and it has since been removed, just silently resume the thread
        if (thread.paused.reasons.length === 1 && thread.paused.reasons[0] === 'breakpoint') {
            const { linenum, qtype} = thread.paused.location;
            const bp = this.dbgr.breakpoints.byID.get(`${linenum}:${qtype}`);
            if (!bp) {
                this.continueThread(thread);
                return;
            }
        }
        // tell VSCode about the stopped thread
        const event = new StoppedEvent(thread.paused.reasons[0], thread.vscode_threadid, thread.paused.last_exception && "Exception thrown");
        thread.paused.stoppedEvent = event;
        this.sendEvent(event);
    }

    /**
     * @param {AndroidThread} thread 
     */
	async continueThread(thread) {
        thread.paused = null;
        this.checkPendingThreadBreaks();
        await this.dbgr.resumeThread(thread.threadid);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.ContinueResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.ContinueArguments} args
     */
	continueRequest(response, args) {
        D(`Continue thread:${args.threadId}`);

        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Continue', args.threadId, response);
        if (!thread.paused) return this.failRequestThreadNotSuspended('Continue', args.threadId, response);

        this.sendResponse(response);
        this.continueThread(thread);
	}

    /**
     * Called by the debugger after a step operation has completed
     */
    onStep(e) {
        // if we step into a breakpoint, both onBreakpointHit and onStep will be called
        D(`step hit: ${e.stoppedLocation}`);
        this.reportStoppedEvent("step", e.stoppedLocation);
    }

    /**
     * Called by the user to start a step operation
     * @param {DebuggerStepType} which 
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextArguments} args
     */
    doStep(which, response, args) {
        D(`step ${which}`);

        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Step', args.threadId, response);
        if (!thread.paused) return this.failRequestThreadNotSuspended('Step', args.threadId, response);

        thread.paused = null;

        this.sendResponse(response);

        // we time the step - if it takes too long to complete, we switch to any other threads that are waiting
        thread.stepTimeout = setTimeout(() => {
            D(`Step timeout on thread: ${thread.threadid}`);
            thread.stepTimeout = null;
            this.checkPendingThreadBreaks();
        }, 2000);

        this.dbgr.step(which, thread.threadid);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.StepInArguments} args
     */
	stepInRequest(response, args) {
        this.doStep('in', response, args);
	}

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextArguments} args
     */
	nextRequest(response, args) {
        this.doStep('over', response, args);
	}

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.NextResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.StepOutArguments} args
     */
	stepOutRequest(response, args) {
        this.doStep('out', response, args);
	}

    /**
     * Called by the debugger if an exception event is triggered
     * @param {JavaExceptionEvent} e
     */
    async onException(e) {
        // it's possible for the debugger to send multiple exception notifications for the same thread, depending on the package filters
        D(`exception hit: ${e.throwlocation}`);
        const thread_id = e.throwlocation.threadid;
        // retrieve the exception object
        const ex_value = await this.dbgr.getExceptionValue(thread_id, e.event.exception)
        const last_exception = new DebuggerException(ex_value, thread_id);
        this.reportStoppedEvent("exception", e.throwlocation, last_exception);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.ExceptionInfoResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.ExceptionInfoArguments} args
     */
    async exceptionInfoRequest(response, args) {
        D(`exceptionInfoRequest: ${args.threadId}`);
        const thread = this.getThread(args.threadId);
        if (!thread) return this.failRequestNoThread('Exception info', args.threadId, response);
        if (!thread.paused) return this.cancelRequestThreadNotSuspended('Exception info', args.threadId, response);
        if (!thread.paused.last_exception) return this.failRequest('No exception available', response);

        // we must wait for the exception object to be retreived as a local (along with the message field)
        const ex_value = thread.paused.last_exception.exceptionValue;
        const message = ex_value.data.msg.string;

        response.body = {
            /** ID of the exception that was thrown. */
            exceptionId: ex_value.type.typename,
            /** Descriptive text for the exception provided by the debug adapter. */
            description: `${os.EOL}${message}`,
            /** Mode that caused the exception notification to be raised. */
            //'never' | 'always' | 'unhandled' | 'userUnhandled';
            breakMode: 'always',
            /** Detailed information about the exception. */
            details: {
                /** Message contained in the exception. */
                message,
                /** Short type name of the exception object. */
                typeName: ex_value.type.typename,
                /** Fully-qualified type name of the exception object. */
                fullTypeName: ex_value.type.fullyQualifiedName(),
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

    /**
     * Called by the debugger if a thread start/end event is triggered
     */
    async onThreadChange(e) {
        D(`thread ${e.state}: ${e.threadid}(${parseInt(e.threadid,16)})`);
        switch(e.state) {
            case 'start': {
                try {
                    const threadinfos = await this.dbgr.getJavaThreadInfos([e.threadid]);
                    const t = this.getThread(threadinfos[0].threadid, threadinfos[0].name);
                    this.sendEvent(new ThreadEvent('started', t.vscode_threadid));
                } catch(e) {
                }
                break;
            }
            case 'end':
                const t = this._threads.find(t => t && t.threadid === e.threadid);
                if (t) {
                    if (t.stepTimeout) {
                        clearTimeout(t.stepTimeout);
                        t.stepTimeout = null;
                    }
                    delete this._threads[t.vscode_threadid];
                    this.sendEvent(new ThreadEvent('exited', t.vscode_threadid));
                    this.checkPendingThreadBreaks();    // in case we were stepping this thread
                }
                break;
        }
        this.dbgr.resumeThread(e.threadid);
    }

    /**
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetVariableResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.SetVariableArguments} args
     */
    async setVariableRequest(response, args) {

        const threadId = AndroidThread.variableRefToThreadId(args.variablesReference);
        const thread = this.getThread(threadId);
        if (!thread) return this.failRequestNoThread('Set variable', threadId, response);
        if (!thread.paused) return this.failRequestThreadNotSuspended('Set variable', threadId, response);

        try {
            // retrieve the stack frame the variable belongs to
            const stack_frame = thread.findStackFrame(args.variablesReference);
            // evaluate the expression
            const locals = await stack_frame.getLocals();
            const { value } = await evaluate(args.value, thread, locals, this.dbgr);
            // update the variable
            const vsvar = await stack_frame.setVariableValue(args.variablesReference, args.name, value);
            response.body = {
                value: vsvar.value,
                type: vsvar.type,
                variablesReference: vsvar.variablesReference,
            };
        } catch (e) {
            response.success = false;
            response.message = e.message;
        }
        this.sendResponse(response);
	}

    /**
     * Called by VSCode to perform watch, console and hover evaluations
     * @param {import('@vscode/debugprotocol').DebugProtocol.EvaluateResponse} response
     * @param {import('@vscode/debugprotocol').DebugProtocol.EvaluateArguments} args
     */
	async evaluateRequest(response, args) {

        // Some notes to remember:
        // annoyingly, during stepping, the step can complete before the resume has called evaluateRequest on watches.
        //      The order can go: doStep(running=true),onStep(running=false),evaluateRequest(),evaluateRequest()
        // so we end up evaluating twice...
        // also annoyingly, this method is called before the locals in the current stack frame are evaluated
        // and even more annoyingly, Android (or JDWP) seems to get confused on the first request when we're retrieving multiple values, fields, etc
        // so we have to queue them or we end up with strange results

        // look for a matching entry in the list (other than at index:0)
        const previdx = this._evals_queue.findIndex(e => e.expression === args.expression);
        if (previdx > 0) {
            // if we find a match, immediately fail the old one and queue the new one
            const prev = this._evals_queue.splice(previdx,1)[0];
            prev.response.success = false;
            prev.response.message = '(evaluating)';
            this.sendResponse(prev.response);
        }

        let eval_info;
        if (args.frameId) {
            const threadId = AndroidThread.variableRefToThreadId(args.frameId);
            const thread = this.getThread(threadId);
            if (!thread) return this.failRequestNoThread('Evaluate',threadId, response);
            if (!thread.paused) return this.failRequestThreadNotSuspended('Evaluate',threadId, response);
            const stack_frame = thread.findStackFrame(args.frameId);
            const locals = await stack_frame.getLocals();
            eval_info = new EvalQueueEntry(args.expression, response, locals, stack_frame, thread);
        } else {
            // if there's no frameId, we are being asked to evaluate the value in the 'global' context.
            // This is a problem because there's no associated stack frame, so we include any locals in the evaluation.
            // We still want the user to be able to call into the runtime to create new objects, evaluate static fields, etc so
            // we choose an arbitrary paused thread to execute on (without this, the only evaluations we could perform
            // would require primitive literals)
            const thread = this._threads.find(t => t && t.paused);
            if (!thread) return this.failRequest(`No threads are paused`, response);
            eval_info = new EvalQueueEntry(args.expression, response, [], thread.getGlobalVariableManager(), thread);
        }

        const queue_len = this._evals_queue.push(eval_info);
        if (queue_len > 1) {
            return;
        }

        while (this._evals_queue.length > 0) {
            const { expression, response, locals, var_manager, thread } = this._evals_queue[0];
            try {
                const { value, display_format } = await evaluate(expression, thread, locals, this.dbgr, { allowFormatSpecifier:true });
                const v = var_manager.makeVariableValue(value, display_format);
                response.body = {
                    result: v.value,
                    variablesReference: v.variablesReference|0
                };
            } catch (e) {
                response.success = false;
                response.message = e.message;
            }
            this.sendResponse(response);
            this._evals_queue.shift();
        }
    }
}

class EvalQueueEntry {
    /**
     * @param {string} expression
     * @param {import('@vscode/debugprotocol').DebugProtocol.EvaluateResponse} response
     * @param {DebuggerValue[]} locals
     * @param {VariableManager} var_manager 
     * @param {AndroidThread} thread
     */
    constructor(expression, response, locals, var_manager, thread) {
        this.expression = expression;
        this.response = response;
        this.locals = locals;
        this.var_manager = var_manager;
        this.thread = thread;
    }
}

/**
 * @param {string} p 
 */
function ensure_path_end_slash(p) {
    return p + (/[\\/]$/.test(p) ? '' : path.sep);
}

/**
 * @param {string} fullpath 
 * @param {string} subpath 
 */
function is_subpath_of(fullpath, subpath) {
    if (!subpath || !fullpath) {
        return false;
    }
    subpath = ensure_path_end_slash(subpath);
    return fullpath.slice(0,subpath.length) === subpath;
}

DebugSession.run(AndroidDebugSession);
