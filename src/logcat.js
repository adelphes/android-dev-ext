'use strict'
// node and external modules
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocketServer = require('ws').Server;
// our stuff
const { ADBClient } = require('./adbclient');
const { AndroidContentProvider } = require('./contentprovider');
const { checkADBStarted } = require('./utils/android');
const { selectTargetDevice } = require('./utils/device');
const { D } = require('./utils/print');

/**
 * WebSocketServer instance
 * @type {WebSocketServer}
 */
let Server = null;

/**
 * Promise resolved once the WebSocketServer is listening
 * @type {Promise}
 */
let wss_inited;

/**
 * hashmap of all LogcatContent instances, keyed on device id
 * @type {Map<string, LogcatContent>}
 */
const LogcatInstances = new Map();

/**
 * Class to manage logcat data transferred between device and a WebView.
 * 
 * Each LogcatContent instance receives logcat lines via ADB, formats them into
 * HTML and sends them to a WebSocketClient running within a WebView page.
 * 
 * The order goes:
 *   - a new LogcatContent instance is created
 *   - if this is the first instance, create the WebSocketServer
 *   - set up handlers to receive logcat messages from ADB
 *   - upon the first get content(), return the templated HTML page - this is designed to bootstrap the view and create a WebSocket client.
 *   - when the client connects, start sending logcat messages over the websocket
 */
class LogcatContent {

    /**
     * @param {string} deviceid 
     */
    constructor(deviceid) {
        this._logcatid = deviceid;
        this._logs = [];
        this._htmllogs = [];
        this._oldhtmllogs = [];
        this._notifying = 0;
        this._refreshRate = 200;    // ms
        this._state = 'connecting';
        this._htmltemplate = '';
        this._adbclient = new ADBClient(deviceid);
        this._initwait = this.initialise();
        LogcatInstances.set(this._logcatid, this);
    }

    /**
     * Ensures the websocket server is initialised and sets up
     * logcat handlers for ADB.
     * Once everything is ready, returns the initial HTML bootstrap content
     * @returns {Promise<string>}
     */
    async initialise() {
        try {
            // create the WebSocket server instance
            await initWebSocketServer();
            // register handlers for logcat
            await this._adbclient.startLogcatMonitor({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
            });
            this._state = 'connected';
            this._initwait = null;
        } catch (err) {
            return `Logcat initialisation failed. ${err.message}`;
        }
        // retrieve the initial content
        return this.content();
    }

    /**
     * @returns {Promise<string>}
     */
    async content() {
        if (this._initwait) return this._initwait;
        if (this._state !== 'disconnected')
            return this.htmlBootstrap({connected:true, status:'',oldlogs:''});
        // if we're in the disconnected state, and this.content is called, it means the user has requested
        // this logcat again - check if the device has reconnected
        return this._initwait = this.tryReconnect();
    }

    async tryReconnect() {
        // clear the logs first - if we successfully reconnect, we will be retrieving the entire logcat again
        const prevlogs = {_logs: this._logs, _htmllogs: this._htmllogs, _oldhtmllogs: this._oldhtmllogs };
        this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
        try {
            await this._adbclient.startLogcatMonitor({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
            })
            // we successfully reconnected
            this._state = 'connected';
            this._initwait = null;
            return this.content();
        } catch(err) {
            // reconnection failed - put the logs back and return the cached info
            this._logs = prevlogs._logs;
            this._htmllogs = prevlogs._htmllogs;
            this._oldhtmllogs = prevlogs._oldhtmllogs;
            this._initwait = null;
            const cached_content = this.htmlBootstrap({
                connected: false,
                status: 'Device disconnected',
                oldlogs: this._oldhtmllogs.join(os.EOL),
            });
            return cached_content;
        }
    }

    sendClientMessage(msg) {
        const clients = [...Server.clients].filter(client => client['_logcatid'] === this._logcatid);
        clients.forEach(client => client.send(msg+'\n'));   // include a newline to try and persuade a buffer write
    }

    sendDisconnectMsg() {
        this.sendClientMessage(':disconnect');
    }

    onClientConnect(client) {
        if (this._oldhtmllogs.length) {
            const lines = '<div class="logblock">' + this._oldhtmllogs.join(os.EOL) + '</div>';
            client.send(lines);
        }
        // if the window is tabbed away and then returned to, vscode assumes the content
        // has not changed from the original bootstrap. So it proceeds to load the html page (with no data),
        // causing a connection to the WSServer as if the connection is still valid (which it was, originally).
        // If it's not, tell the client (again) that the device has disconnected
        if (this._state === 'disconnected')
            this.sendDisconnectMsg();
    }

    onClientMessage(client, message) {
        if (message === 'cmd:clear_logcat') {
            if (this._state !== 'connected') return;
            new ADBClient(this._adbclient.deviceid).shell_cmd({command:'logcat -c'})
                .then(() => {
                    // clear everything and tell the clients
                    this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
                    this.sendClientMessage(':logcat_cleared');
                })
                .catch(e => {
                    D('Clear logcat command failed: ' + e.message);
                })
        }
    }

    updateLogs() {
        // no point in formatting the data if there are no connected clients
        const clients = [...Server.clients].filter(client => client['_logcatid'] === this._logcatid);
        if (clients.length) {
            const lines = '<div class="logblock">' + this._htmllogs.join('') + '</div>';
            clients.forEach(client => client.send(lines));
        }
        // once we've updated all the clients, discard the info
        this._oldhtmllogs = this._htmllogs.concat(this._oldhtmllogs).slice(0, 10000);
        this._htmllogs = [], this._logs = [];
    }

    htmlBootstrap(vars) {
        if (!this._htmltemplate)
            this._htmltemplate = fs.readFileSync(path.join(__dirname,'res/logcat.html'), 'utf8');
        vars = Object.assign({
            logcatid: this._logcatid,
            wssport: Server.options.port,
        }, vars);
        // simple value replacement using !{name} as the placeholder
        const html = this._htmltemplate.replace(/!\{(.*?)\}/g, (match,expr) => ''+(vars[expr.trim()]||''));
        return html;
    }
    renotify() {
        if (++this._notifying > 1) return;
        this.updateLogs();
        setTimeout(() => {
            if (--this._notifying) {
                this._notifying = 0;
                this.renotify();
            }
        }, this._refreshRate);
    }
    onLogcatContent(e) {
        if (e.logs.length) {
            const mrlast = e.logs.slice();
            this._logs = this._logs.concat(mrlast);
            mrlast.forEach(log => {
                if (!(log = log.trim())) return;
                // replace html-interpreted chars
                const m = log.match(/^\d\d-\d\d\s+?\d\d:\d\d:\d\d\.\d+?\s+?(.)/);
                const style = (m && m[1]) || '';
                log = log.replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
                this._htmllogs.unshift(`<div class="log ${style}">${log}</div>`);
                
            });
            this.renotify();
        }
    }
    onLogcatDisconnect(/*e*/) {
        if (this._state === 'disconnected') return;
        this._state = 'disconnected';
        this.sendDisconnectMsg();
    }
}

function initWebSocketServer() {
    if (wss_inited) {
        // already inited
        return wss_inited;
    }

    // retrieve the logcat websocket port
    const default_wssport = 7038;
    let start_port = AndroidContentProvider.getLaunchConfigSetting('logcatPort', default_wssport);
    if (typeof start_port !== 'number' || start_port <= 0 || start_port >= 65536 || start_port !== (start_port|0)) {
        start_port = default_wssport;
    }

    wss_inited = new Promise((resolve, reject) => {
        let retries = 100;
        tryCreateWebSocketServer(start_port, retries, (err, server) => {
            if (err) {
                wss_inited = null;
                reject(err);
            } else {
                Server = server;
                resolve();
            }
        });
    });
    return wss_inited;
}

/**
 * 
 * @param {number} port 
 * @param {number} retries 
 * @param {(err,server?) => void} cb 
 */
function tryCreateWebSocketServer(port, retries, cb) {
    const wsopts = {
        host: '127.0.0.1',
        port,
        clientTracking: true,
    };
    new WebSocketServer(wsopts)
        .on('listening', function() {
            cb(null, this);
        })
        .on('connection', (client, req) => {
            onWebSocketClientConnection(client, req);
        })
        .on('error', err => {
            if (retries <= 0) {
                cb(err);
            } else {
                tryCreateWebSocketServer(port + 1, retries - 1, cb);
            }
        })
}

function onWebSocketClientConnection(client, req) {
    // the client uses the url path to signify which logcat data it wants
    client._logcatid = req.url.match(/^\/?(.*)$/)[1];
    const lc = LogcatInstances.get(client._logcatid);
    if (!lc) {
        client.close();
        return;
    }
    lc.onClientConnect(client);
    client.on('message', function(message) {
        const lc = LogcatInstances.get(this._logcatid);
        if (lc) {
            lc.onClientMessage(this, message);
        }
    }.bind(client));

    // try and make sure we don't delay writes
    client._socket && typeof(client._socket.setNoDelay)==='function' && client._socket.setNoDelay(true);
}

/**
 * @param {import('vscode')} vscode 
 * @param {*} target_device 
 */
function openWebviewLogcatWindow(vscode, target_device) {
    const panel = vscode.window.createWebviewPanel(
        'androidlogcat', // Identifies the type of the webview. Used internally
        `logcat-${target_device.serial}`, // Title of the panel displayed to the user
        vscode.ViewColumn.Two, // Editor column to show the new webview panel in.
        {
            enableScripts: true,    // we use embedded scripts to relay logcat info over a websocket
        }
    );
    const logcat = new LogcatContent(target_device.serial);
    logcat.content().then(html => {
        panel.webview.html = html;
    });
}

/**
 * @param {import('vscode')} vscode 
 * @param {*} target_device 
 */
function openPreviewHtmlLogcatWindow(vscode, target_device) {
    const uri = AndroidContentProvider.getReadLogcatUri(target_device.serial);
    vscode.commands.executeCommand("vscode.previewHtml", uri, vscode.ViewColumn.Two);
}

/**
 * @param {import('vscode')} vscode 
 */
async function openLogcatWindow(vscode) {
    try {
        // if adb is not running, see if we can start it ourselves
        const autoStartADB = AndroidContentProvider.getLaunchConfigSetting('autoStartADB', true);
        await checkADBStarted(autoStartADB);

        let target_device = await selectTargetDevice(vscode, "Logcat display");
        if (!target_device) {
            return;
        }

        if (vscode.window.createWebviewPanel) {
            // newer versions of vscode use WebviewPanels
            openWebviewLogcatWindow(vscode, target_device);
        } else {
            // older versions of vscode use previewHtml
            openPreviewHtmlLogcatWindow(vscode, target_device);
        }
    } catch (e) {
        vscode.window.showInformationMessage(`Logcat cannot be displayed. ${e.message}`);
    }
}

module.exports = {
    LogcatContent,
    openLogcatWindow,
}
