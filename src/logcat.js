'use strict'
// vscode stuff
const { EventEmitter, Uri } = require('vscode');
// node and external modules
const os = require('os');
const path = require('path');
const WebSocketServer = require('ws').Server;
// our stuff
const { ADBClient } = require('./adbclient');
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
        this._adbclient = new ADBClient(uri.query);
        this._initwait = new Promise((resolve, reject) => {
            this._state = 'connecting';
            LogcatContent.initWebSocketServer()
                .then(() => {
                    return this._adbclient.logcat({
                        onlog: this.onLogcatContent.bind(this),
                        onclose: this.onLogcatDisconnect.bind(this),
                    });
                }).then(x => {
                    this._state = 'connected';
                    this._initwait = null;
                    resolve(this.content);
                }).fail(e => {
                    this._state = 'connect_failed';
                    reject(e)
                    this._provider._notifyLogDisconnected(this);
                })
        });
    }
    get content() {
        if (this._initwait) return this._initwait;
        if (this._state !== 'disconnected')
            return this.htmlBootstrap(true, '');
        // if we're in the disconnected state, and this.content is called, it means the user has requested
        // this logcat again - check if the device has reconnected
        return this._initwait = new Promise((resolve, reject) => {
            // clear the logs first - if we successfully reconnect, we will be retrieving the entire logcat again
            this._prevlogs = {_logs: this._logs, _htmllogs: this._htmllogs, _oldhtmllogs: this._oldhtmllogs };
            this._logs = []; this._htmllogs = []; this._oldhtmllogs = [];
            this._adbclient.logcat({
                onlog: this.onLogcatContent.bind(this),
                onclose: this.onLogcatDisconnect.bind(this),
            }).then(x => {
                // we successfully reconnected
                this._state = 'connected';
                this._prevlogs = null;
                this._initwait = null;
                resolve(this.content);
            }).fail(e => {
                // reconnection failed - put the logs back and return the cached info
                this._logs = this._prevlogs._logs;
                this._htmllogs = this._prevlogs._htmllogs;
                this._oldhtmllogs = this._prevlogs._oldhtmllogs;
                this._prevlogs = null;
                this._initwait = null;
                var cached_content = this.htmlBootstrap(false, 'Device disconnected');
                resolve(cached_content);
            })
        });
    }
    sendDisconnectMsg() {
        var clients = LogcatContent._wss.clients.filter(client => client._logcatid === this._logcatid);
        clients.forEach(client => client.send(':disconnect'));
    }
    updateLogs() {
        // no point in formatting the data if there are no connected clients
        var clients = LogcatContent._wss.clients.filter(client => client._logcatid === this._logcatid);
        if (clients.length) {
            var lines = '<div style="display:inline-block">' + this._htmllogs.join('') + '</div>';
            clients.forEach(client => client.send(lines));
        }
        // once we've updated all the clients, discard the info
        this._oldhtmllogs = this._htmllogs.concat(this._oldhtmllogs).slice(0, 5000);
        this._htmllogs = [], this._logs = [];
    }
    htmlBootstrap(connected, statusmsg) {
        return `<!DOCTYPE html>
            <html><head>
            <style type="text/css">
                .V {color:#999}
                .D {color:#519B4F}
                .I {color:#CCC0D3}
                .W {color:#BD955C}
                .E {color:#f88}
                .F {color:#f66}
                .hide {display:none}
                .unhide {display:inline-block}
            </style></head>
            <body style="color:#fff;font-size:.9em">
            <div id="status" style="color:#888">${statusmsg}</div>
            <div id="rows">${this._oldhtmllogs.join(os.EOL)}</div>
            <script>
                function start() {
                    var rows = document.getElementById('rows');
                    var last_known_scroll_position=0, selectall=0;
                    var selecttext = (rows) => {
                        if (!rows) return window.getSelection().empty();
                        var range = document.createRange();
                        range.selectNode(rows);
                        window.getSelection().addRange(range);
                    }
                    window.addEventListener('scroll', function(e) {
                        if ((last_known_scroll_position = window.scrollY)===0) {
                            var hidden = document.getElementsByClassName('hide');
                            for (var i=hidden.length-1; i>=0; i--)
                                hidden[i].className='unhide';
                        }
                    });
                    window.addEventListener('keypress', function(e) {
                        if (e.ctrlKey && /[aA]/.test(e.key) && !selectall) {
                            selectall = 1;
                            selecttext(rows);
                        }
                    });
                    window.addEventListener('keyup', function(e) {
                        selectall = 0;
                        /^escape$/i.test(e.key) && selecttext(null);
                    });
                    var setStatus = (x) => { document.getElementById('status').textContent = x; }
                    var connect = () => {
                        try { 
                            setStatus('Connecting...');
                            var x = new WebSocket('ws://127.0.0.1:${LogcatContent._wssport}/${this._logcatid}');
                            x.onopen = e => { setStatus('') };x.onclose = e => { };x.onerror = e => { setStatus('Connection error')  }
                            x.onmessage = e => {
                                var logs = e.data;
                                if (/^:disconnect$/.test(logs)) {
                                    x.close(),setStatus('Device disconnected');
                                    return;
                                }
                                if (last_known_scroll_position > 0) 
                                    logs = '<div class="hide">'+logs+'</div>';
                                rows && rows.insertAdjacentHTML('afterbegin',logs);
                            };
                        }
                        catch(e) { setStatus('Connection exception') }
                    }
                    ${connected ? '' : '//'} connect();
                }
                setTimeout(start, 100);
            </script>
            </body>
            </html>`;
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
            var mrfirst = e.logs.slice().reverse();
            this._logs = mrfirst.concat(this._logs);
            mrfirst.forEach(log => {
                if (!(log = log.trim())) return;
                // replace html-interpreted chars
                var m = log.match(/^\d\d-\d\d\s+?\d\d:\d\d:\d\d\.\d+?\s+?(.)/);
                var style = (m && m[1]) || '';
                log = log.replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
                this._htmllogs.unshift(`<div class="${style}">${log}</div>`);
            })
            this.renotify();
        }
    }
    onLogcatDisconnect(e) {
        if (this._state === 'disconnected') return;
        this._state = 'disconnected';
        this.sendDisconnectMsg();
    }
}

LogcatContent.initWebSocketServer = function () {
    if (LogcatContent._wssdone) {
        // already inited
        return LogcatContent._wssdone;
    }
    LogcatContent._wssdone = $.Deferred();
    ({
        wss: null,
        port: 31100,
        retries: 0,
        tryCreateWSS() {
            this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port }, () => {
                // success - save the info and resolve the deferred
                LogcatContent._wssport = this.port;
                LogcatContent._wss = this.wss;
                this.wss.on('connection', client => {
                    // the client uses the url path to signify which logcat data it wants
                    client._logcatid = client.upgradeReq.url.match(/^\/?(.*)$/)[1];
                    // we're not really interested in anything the client sends
                    /*client.on('message', message => {
                        console.log('ws received: %s', message);
                    });
                    client.on('close', e => {
                        console.log('ws close');
                    });*/
                });
                this.wss = null;
                LogcatContent._wssdone.resolveWith(LogcatContent, []);
            });
            this.wss.on('error', err => {
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

class AndroidContentProvider /*extends TextDocumentContentProvider*/ {

    constructor() {
        this._logs = {};    // hashmap<url, LogcatContent>
        this._onDidChange = new EventEmitter();
    }

    dispose() {
        this._onDidChange.dispose();
    }

    /**
     * An event to signal a resource has changed.
     */
    get onDidChange() {
        return this._onDidChange.event;
    }

    /**
     * Provide textual content for a given uri.
     *
     * The editor will use the returned string-content to create a readonly
     * [document](TextDocument). Resources allocated should be released when
     * the corresponding document has been [closed](#workspace.onDidCloseTextDocument).
     *
     * @param uri An uri which scheme matches the scheme this provider was [registered](#workspace.registerTextDocumentContentProvider) for.
     * @param token A cancellation token.
     * @return A string or a thenable that resolves to such.
     */
    provideTextDocumentContent(uri/*: Uri*/, token/*: CancellationToken*/)/*: string | Thenable<string>;*/ {
        var doc = this._logs[uri];
        if (doc) return this._logs[uri].content;
        switch (uri.authority) {
            case 'logcat': return this.provideLogcatDocumentContent(uri);
        }
        throw new Error('Document Uri not recognised');
    }

    provideLogcatDocumentContent(uri) {
        var doc = this._logs[uri] = new LogcatContent(this, uri);
        return doc.content;
    }
}

// the statics
AndroidContentProvider.SCHEME = 'android-dev-ext'; // android-dev-ext://logcat/read?device=<deviceid>
AndroidContentProvider.register = (ctx, workspace) => {
    var provider = new AndroidContentProvider();
    var registration = workspace.registerTextDocumentContentProvider(AndroidContentProvider.SCHEME, provider);
    ctx.subscriptions.push(registration);
    ctx.subscriptions.push(provider);
}
AndroidContentProvider.getReadLogcatUri = (deviceId) => {
    var uri = Uri.parse(`${AndroidContentProvider.SCHEME}://logcat/logcat-${deviceId}.txt`);
    return uri.with({
        query: deviceId
    });
}

function openLogcatWindow(vscode) {
    new ADBClient().list_devices().then(devices => {
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
    .fail(e => {
        vscode.window.showInformationMessage('Logcat cannot be displayed. Querying the connected devices list failed. Is ADB running?');
    });
}

exports.AndroidContentProvider = AndroidContentProvider;
exports.openLogcatWindow = openLogcatWindow;
