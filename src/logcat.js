'use strict'
// node and external modules
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocketServer = require('ws').Server;
// our stuff
const { ADBClient } = require('./adbclient');
const { AndroidContentProvider } = require('./contentprovider');
const $ = require('./jq-promise');
const { D } = require('./util');

/*
    Class to setup and store logcat data
 */
class LogcatContent {

    constructor(provider/*: AndroidContentProvider*/, uri/*: Uri*/) {
        this._provider = provider;
        this._uri = uri;
        this._logcatid = uri.query;
        this._logs = [];
        this._htmllogs = [];
        this._oldhtmllogs = [];
        this._prevlogs = null;
        this._notifying = 0;
        this._refreshRate = 200;    // ms
        this._state = '';
        this._htmltemplate = '';
        this._adbclient = new ADBClient(uri.query);
        this._initwait = new Promise((resolve, reject) => {
            this._state = 'connecting';
            LogcatContent.initWebSocketServer()
                .then(() => {
                    return this._adbclient.logcat({
                        onlog: this.onLogcatContent.bind(this),
                        onclose: this.onLogcatDisconnect.bind(this),
                    });
                }).then(() => {
                    this._state = 'connected';
                    this._initwait = null;
                    resolve(this.content);
                }).fail(e => {
                    this._state = 'connect_failed';
                    reject(e);
                })
        });
        LogcatContent.byLogcatID[this._logcatid] = this;
    }
    get content() {
        if (this._initwait) return this._initwait;
        if (this._state !== 'disconnected')
            return this.htmlBootstrap({connected:true, status:'',oldlogs:''});
        // if we're in the disconnected state, and this.content is called, it means the user has requested
        // this logcat again - check if the device has reconnected
        return this._initwait = new Promise((resolve/*, reject*/) => {
            // clear the logs first - if we successfully reconnect, we will be retrieving the entire logcat again
            this._prevlogs = {_logs: this._logs, _htmllogs: this._htmllogs, _oldhtmllogs: this._oldhtmllogs };
            this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
            this._adbclient.logcat({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
            }).then(() => {
                // we successfully reconnected
                this._state = 'connected';
                this._prevlogs = null;
                this._initwait = null;
                resolve(this.content);
            }).fail((/*e*/) => {
                // reconnection failed - put the logs back and return the cached info
                this._logs = this._prevlogs._logs;
                this._htmllogs = this._prevlogs._htmllogs;
                this._oldhtmllogs = this._prevlogs._oldhtmllogs;
                this._prevlogs = null;
                this._initwait = null;
                var cached_content = this.htmlBootstrap({connected:false, status:'Device disconnected',oldlogs: this._oldhtmllogs.join(os.EOL)});
                resolve(cached_content);
            })
        });
    }
    sendClientMessage(msg) {
        var clients = LogcatContent._wss.clients.filter(client => client._logcatid === this._logcatid);
        clients.forEach(client => client.send(msg+'\n'));   // include a newline to try and persuade a buffer write
    }
    sendDisconnectMsg() {
        this.sendClientMessage(':disconnect');
    }
    onClientConnect(client) {
        if (this._oldhtmllogs.length) {
            var lines = '<div class="logblock">' + this._oldhtmllogs.join(os.EOL) + '</div>';
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
                .fail(e => {
                    D('Clear logcat command failed: ' + e.message);
                })
        }
    }
    updateLogs() {
        // no point in formatting the data if there are no connected clients
        var clients = LogcatContent._wss.clients.filter(client => client._logcatid === this._logcatid);
        if (clients.length) {
            var lines = '<div class="logblock">' + this._htmllogs.join('') + '</div>';
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
            wssport: LogcatContent._wssport,
        }, vars);
        // simple value replacement using !{name} as the placeholder
        var html = this._htmltemplate.replace(/!\{(.*?)\}/g, (match,expr) => ''+(vars[expr.trim()]||''));
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
            var mrlast = e.logs.slice();
            this._logs = this._logs.concat(mrlast);
            mrlast.forEach(log => {
                if (!(log = log.trim())) return;
                // replace html-interpreted chars
                var m = log.match(/^\d\d-\d\d\s+?\d\d:\d\d:\d\d\.\d+?\s+?(.)/);
                var style = (m && m[1]) || '';
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

// hashmap of all LogcatContent instances, keyed on device id
LogcatContent.byLogcatID = {};

LogcatContent.initWebSocketServer = function () {

    if (LogcatContent._wssdone) {
        // already inited
        return LogcatContent._wssdone;
    }

    // retrieve the logcat websocket port
    var default_wssport = 7038;
    var wssport = AndroidContentProvider.getLaunchConfigSetting('logcatPort', default_wssport);
    if (typeof wssport !== 'number' || wssport <= 0 || wssport >= 65536 || wssport !== (wssport|0))
        wssport = default_wssport;

    LogcatContent._wssdone = $.Deferred();
    ({
        wss: null,
        startport: wssport,
        port: wssport,
        retries: 0,
        tryCreateWSS() {
            this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, () => {
                // success - save the info and resolve the deferred
                LogcatContent._wssport = this.port;
                LogcatContent._wssstartport = this.startport;
                LogcatContent._wss = this.wss;
                this.wss.on('connection', client => {
                    // the client uses the url path to signify which logcat data it wants
                    client._logcatid = client.upgradeReq.url.match(/^\/?(.*)$/)[1];
                    var lc = LogcatContent.byLogcatID[client._logcatid];
                    if (lc) lc.onClientConnect(client);
                    else client.close();
                    client.on('message', function(message) {
                        var lc = LogcatContent.byLogcatID[this._logcatid];
                        if (lc) lc.onClientMessage(this, message);
                    }.bind(client));
                    /*client.on('close', e => {
                        console.log('client close');
                    });*/
                    // try and make sure we don't delay writes
                    client._socket && typeof(client._socket.setNoDelay)==='function' && client._socket.setNoDelay(true);
                });
                this.wss = null;
                LogcatContent._wssdone.resolveWith(LogcatContent, []);
            });
            this.wss.on('error', (/*err*/) => {
                if (!LogcatContent._wss) {
                    // listen failed -try the next port
                    this.retries++ , this.port++;
                    this.tryCreateWSS();
                }
            })
        }
    }).tryCreateWSS();
    return LogcatContent._wssdone;
}

function getADBPort() {
    var defaultPort = 5037;
    var adbPort = AndroidContentProvider.getLaunchConfigSetting('adbPort', defaultPort);
    if (typeof adbPort === 'number' && adbPort === (adbPort|0))
        return adbPort;
    return defaultPort;
}

function openLogcatWindow(vscode) {
    new ADBClient().test_adb_connection()
    .then(err => {
        // if adb is not running, see if we can start it ourselves using ANDROID_HOME (and a sensible port number)
        var adbport = getADBPort();
        var autoStartADB = AndroidContentProvider.getLaunchConfigSetting('autoStartADB', true);
        if (err && autoStartADB!==false && process.env.ANDROID_HOME && typeof adbport === 'number' && adbport > 0 && adbport < 65536) {
            var adbpath = path.join(process.env.ANDROID_HOME, 'platform-tools', /^win/.test(process.platform)?'adb.exe':'adb');
            var adbargs = ['-P',''+adbport,'start-server'];
            try {
                /*var stdout = */require('child_process').execFileSync(adbpath, adbargs, {cwd:process.env.ANDROID_HOME, encoding:'utf8'});
            } catch (ex) {} // if we fail, it doesn't matter - the device query will fail and the user will have to work it out themselves
        }
    })
    .then(() => new ADBClient().list_devices())
    .then(devices => {
        switch(devices.length) {
            case 0: 
                vscode.window.showInformationMessage('Logcat cannot be displayed. No Android devices are currently connected');
                return null;
            case 1:
                return devices; // only one device - just show it
        }
        var multidevicewait = $.Deferred(), prefix = 'Android: View Logcat - ', all = '[ Display All ]';
        var devicelist = devices.map(d => prefix + d.serial);
        //devicelist.push(prefix + all);
        vscode.window.showQuickPick(devicelist)
            .then(which => {
                if (!which) return; // user cancelled
                which = which.slice(prefix.length);
                new ADBClient().list_devices()
                    .then(devices => {
                        if (which === all) return multidevicewait.resolveWith(this,[devices]);
                        var found = devices.find(d => d.serial===which);
                        if (found) return multidevicewait.resolveWith(this,[[found]]);
                        vscode.window.showInformationMessage('Logcat cannot be displayed. The device is disconnected');
                    });
            });
        return multidevicewait;
    })
    .then(devices => {
        if (!Array.isArray(devices)) return;    // user cancelled (or no devices connected)
        devices.forEach(device => {
            var uri = AndroidContentProvider.getReadLogcatUri(device.serial);
            return vscode.commands.executeCommand("vscode.previewHtml",uri,vscode.ViewColumn.Two);
        });
    })
    .fail((/*e*/) => {
        vscode.window.showInformationMessage('Logcat cannot be displayed. Querying the connected devices list failed. Is ADB running?');
    });
}

exports.LogcatContent = LogcatContent;
exports.openLogcatWindow = openLogcatWindow;
