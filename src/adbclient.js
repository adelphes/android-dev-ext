/*
    ADBClient: class to manage connection and commands to adb (via the Dex plugin) running on the local machine.
*/
const _JDWP = require('./jdwp')._JDWP;
const WebSocket = require('./minwebsocket').WebSocketClient;
const { atob,btoa } = require('./util');

function ADBClient(deviceid) {
    this.deviceid = deviceid;
    this.status = 'notinit';
    this.reset();
    this.JDWP = new _JDWP();
}

ADBClient.prototype = {

    reset : function() {
        this.ws = null;
        this.activepromise = {};
        this.authdone = false;
        this.fd = -1;
        this.disconnect_reject_reason = null;
    },

    _parse_device_list:function(data, extended) {
        var lines = atob(data).trim().split(/\r\n?|\n/);
        lines.sort();
        var devicelist = [];
        var i=0;
        if (extended) {
            for (var i=0; i < lines.length; i++) {
                try {
                    var m = JSON.parse(lines[i]);
                    if (!m) continue;
                    m.num = i;
                } catch(e) {continue;}
                devicelist.push(m);
            }
        } else {
            for (var i=0; i < lines.length; i++) {
                var m = lines[i].match(/([^\t]+)\t([^\t]+)/);
                if (!m) continue;
                devicelist.push({
                    serial: m[1],
                    status: m[2],
                    num:i,
                });
            }
        }
        return devicelist;
    },

    track_devices_extended : function(o) {
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('track_devices', 'wa', this.fd = fd, 'host:track-devices-extended'))
            .then(() => this.dexcmd('ra', this.fd))
            .then(data => {
                const nextdeviceinfo = (data) => {
                    this.dexcmd('ra', this.fd, null, {notimeout:true})
                        .then(nextdeviceinfo);
                    const devicelist = this._parse_device_list(data, true);
                    o.ondevices(devicelist, this);
                }
                nextdeviceinfo(data);
            });
    },

    finish_track_devices : function() {
        return this.dexcmd('dc', this.fd)
            .then(() => this.proxy_disconnect());
    },

    test_adb_connection : function() {
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd('dc', this.fd = fd))
            .then(() => this.proxy_disconnect())
            // if we fail, still resolve the promise, passing the error
            .catch(err => err)
    },

    list_devices : function() {
        let devicelist;
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('list_devices', 'wa', this.fd = fd, 'host:devices'))
            .then(() => this.dexcmd('ra', this.fd))
            .then((data) => {
                devicelist = this._parse_device_list(data);
                return this.dexcmd('dc', this.fd);
            })
            .then(() => this.proxy_disconnect())
            .then(() => devicelist);
    },

    jdwp_list : function() {
        let stdout;
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('set_transport', 'wa', this.fd = fd, `host:transport:${this.deviceid}`))
            .then(() => this.dexcmd_read_status('jdwp', 'wa', this.fd, 'jdwp'))
            .then(() => this.dexcmd_read_stdout(this.fd))
            .then((data) => {
                stdout = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(() => this.proxy_disconnect())
            .then(() => stdout.trim().split(/\r?\n|\r/))
    },

    jdwp_forward : function(o) {
        // localport:1234
        // jdwp:1234
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('forward', 'wa', this.fd = fd, `host-serial:${this.deviceid}:forward:tcp:${o.localport};jdwp:${o.jdwp}`))
            .then(() => this.dexcmd('dc', this.fd))
            .then(() => this.proxy_disconnect())
    },

    forward_remove_all : function() {
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('forward_remove_all', 'wa', this.fd = fd, 'host:killforward-all'))
            .then(() => this.dexcmd('dc', this.fd))
            .then(() => this.proxy_disconnect())
    },

    jdwp_connect : function(o) {
        // {localport:1234, onreply:fn()}
        // note that upon success, this method does not close the connection
        this.jdwpinfo = {
            localport: o.localport,
            onreply: o.onreply,
            received: [],
        };
        return this.proxy_connect()
            .then(() => this.dexcmd('cp', o.localport))
            .then(jdwpfd => this.dexcmd('wx', this.jdwpfd = jdwpfd, 'JDWP-Handshake'))
            .then(() => this.dexcmd_read_stdout(this.jdwpfd))
            .then((data) => {
                if (data !== 'JDWP-Handshake') {
                    // disconnect and fail
                    return this.dexcmd('dc', this.jdwpfd)
                        .then(() => this.proxy_disconnect_with_fail({cat:'jdwp', msg:'Invalid handshake response'}));
                }
                // start the monitor - we don't want it terminated on timeout
                return this.logsend('rj', `rj ${this.jdwpfd}`, {notimeout:true})
                    .then(() => { }) // the first rj reply is a blank ok message indicating the monitor  has started
            })
    },

    jdwp_command : function(o) {
        // cmd: JDWP.Command
        // resolveonreply: true/false
        
        // send the raw command over the socket - the reply
        // is received via the JDWP monitor

        return this.dexcmd('wx', this.jdwpfd, o.cmd.toRawString())
            .catch((err) => o.cmd.completion.reject(err))
            .then(() => o.cmd.promise)
            .then(reply => {
                return reply.decoded;
            });
    },

    jdwp_disconnect : function() {
        return this.dexcmd('dc', this.jdwpfd)
            .then(() => {
                delete this.jdwpfd;
                return this.proxy_disconnect();
            })
    },

    readwritesocket : function(o) {
        let socket_reply;
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd('qs', this.fd = fd, `${o.port}:${o.readlen}:${o.data}`))
            .then(data => {
                socket_reply = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(() => this.proxy_disconnect())
            .then(() => socket_reply);
    },

    shell_cmd : function(o) {
        // command='ls /'
        // untilclosed=true
        let stdout;
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('set_transport', 'wa', this.fd = fd, `host:transport:${this.deviceid}`))
            .then(() => this.dexcmd_read_status('shell_cmd', 'wa', this.fd, `shell:${o.command}`))
            .then(() => this.dexcmd_read_stdout(this.fd, !!o.untilclosed))
            .then((data) => {
                stdout = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(() => this.proxy_disconnect())
            .then(() => stdout)
    },

    logcat : function(o) {
        // onlog:function(e)
        // onclose:function(e)
        // data:anything
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('set_transport', 'wa', this.fd = fd, `host:transport:${this.deviceid}`))
            .then(() => this.dexcmd_read_status('shell_cmd', 'wa', this.fd, 'shell:logcat -v time'))
            .then(() => {
                // if there's no handler, just read the complete log and finish
                if (!o.onlog) {
                    let logcatbuffer;
                    return this.dexcmd_read_stdout(this.fd)
                        .then(data => {
                            logcatbuffer = data;
                            return this.dexcmd('dc', this.fd);
                        })
                        .then(() => this.proxy_disconnect())
                        .then(() => logcatbuffer);
                }

                // start the logcat monitor
                return this.dexcmd('so', this.fd)
                    .then(() => {
                        this.logcatinfo = {
                            buffer: '',
                            onlog: o.onlog || (()=>{}),
                            onlogdata: o.data,
                            onclose: o.onclose || (()=>{}),
                            fd: this.fd,
                        }
                        const _waitfornextlogcat = () => {
                            // create a new promise for when the next message is received
                            this.activepromise.so = {
                                resolve: data => {
                                    const decodeddata = atob(data);
                                    if (decodeddata === 'eoso:d10d9798-1351-11e5-bdd9-5b316631f026') {
                                        this.logcatinfo.fd = 0;
                                        this.proxy_disconnect()
                                        .catch(() => {})
                                        .then(() => {
                                            const e = {
                                                adbclient: this,
                                                data: this.logcatinfo.onlogdata,
                                            };
                                            this.logcatinfo.onclose.call(this, e);
                                            if (this.logcatinfo.end) {
                                                this.logcatinfo.end();
                                            }
                                        });
                                        return;
                                    }
                                    _waitfornextlogcat();
                                    const content = this.logcatinfo.buffer + decodeddata;
                                    const logs = content.split(/\r\n?|\n/);
                                    if (/[\r\n]$/.test(content)) {
                                        this.logcatinfo.buffer = ''
                                    } else {
                                        this.logcatinfo.buffer = logs.pop();
                                    }
                                    const e = {
                                        adbclient: this,
                                        data: this.logcatinfo.onlogdata,
                                        logs,
                                    };
                                    this.logcatinfo.onlog.call(this, e);
                                }
                            }
                        }
                        _waitfornextlogcat();
                    });
            });
    },

    endlogcat : function() {
        const logcatfd = this.logcatinfo && this.logcatinfo.fd;

        if (!logcatfd)
            return Promise.resolve();
        this.logcatinfo.fd = 0;

        // close the connection - the monitor callback will resolve the promise
        this.logcatinfo.end = this.dexcmd('dc', logcatfd);
        return new Promise(resolve => this.logcatinfo.end = resolve);
    },

    push_file : function(o) {
        // filepathname='/data/local/tmp/fname'
        // filedata:<arraybuffer>
        // filemtime:12345678
        let push_file_info = Object.assign(o);
        return this.proxy_connect()
            .then(() => this.dexcmd('cn'))
            .then(fd => this.dexcmd_read_status('set_transport', 'wa', this.fd = fd, `host:transport:${this.deviceid}`))
            .then(() => this.dexcmd_read_status('sync', 'wa', this.fd, 'sync:'))
            .then(() => {
                const perms = '33204';
                const cmddata = `${push_file_info.filepathname},${perms}`;
                const cmd='SEND'+String.fromCharCode(cmddata.length)+'\0\0\0'+cmddata;
                return this.dexcmd('wx', this.fd, cmd);
            })
            .then(() => this.dexcmd_write_data(push_file_info.filedata))
            .then(() => {
                let cmd = 'DONE';
                const mtime = push_file_info.filemtime;
                for(let i=0;i < 4; i++)
                    cmd += String.fromCharCode((mtime>>(i*8))&255);
                return this.dexcmd_read_sync_response('done', 'wx', this.fd, cmd);
            })
            .then(() => {
                this.progress = 'quit';
                const cmd = 'QUIT\0\0\0\0';
                return this.dexcmd('wx', this.fd, cmd);
            })
            .then(() => this.dexcmd('dc', this.fd))
            .then(() => this.proxy_disconnect());
    },

    do_auth : function(msg) {
        var m = msg.match(/^vscadb proxy version 1/);
        if (m) {
            this.authdone = true;
            this.status='connected';
            return this.activepromise.auth.resolve();
        }
        return this.proxy_disconnect_with_fail({cat:"Authentication", msg:"Proxy handshake failed"});
    },

    proxy_disconnect_with_fail : function(reason) {
        this.disconnect_reject_reason = reason;
        return this.proxy_disconnect();
    },

    proxy_disconnect : function() {
        this.ws && this.ws.close();
        return this.activepromise.disconnected;
    },

    proxy_onerror : function() {
        var reason;
        if (this.status!=='connecting') {
            reason= {cat:"Protocol", msg:"Connection fault"};
        } else {
            reason = {cat:"Connection", msg:"A connection to the Dex debugger could not be established.", nodbgr:true};
        }
        this.proxy_disconnect_with_fail(reason);
    },

    proxy_onmessage : function(e) {
        if (!this.authdone)
            return this.do_auth(e.data);
        var cmd = e.data.substring(0, 2);
        var msgresult = e.data.substring(3, 5);
        if (cmd === 'rj' && this.jdwpinfo) {
            // rj is the receive-jdwp reply - it is handled separately
            if (this.jdwpinfo.started) {
                this.jdwpinfo.received.push(e.data.substring(6));
                if (this.jdwpinfo.received.length > 1) return;
                process.nextTick(() => {
                    while (this.jdwpinfo.received.length) {
                        var nextdata = this.jdwpinfo.received.shift();
                        this.jdwpinfo.onreply(atob(nextdata));
                    }
                });
                return;
            }
            if (e.data === 'rj ok')
                this.jdwpinfo.started = new Date();
        }
        var err;
        var ap = this.activepromise[cmd], p = ap;
        if (Array.isArray(p))
            p = p.shift();
        if (msgresult === "ok") {
            if (p) {
                if (!ap.length)
                    this.activepromise[cmd] = null;
                p.resolve(e.data.substring(6));
                return;
            }
            err = {cat:"Command", msg:'Missing response message: ' + cmd};
        } else if (e.data==='cn error connection failed') {
            // this is commonly expected, so remap the error to something nice
            err = {cat:"Connection", msg:'ADB server is not running or cannot be contacted'};
        } else {
            err = {cat:"Command", msg:e.data};
        }
        this.proxy_disconnect_with_fail(err);
    },

    proxy_onclose : function() {
        // when disconnecting, reject any pending promises first
        var pending = [];
        for (var cmd in this.activepromise) {
            do {
                var p = this.activepromise[cmd];
                if (!p) break;
                if (Array.isArray(p))
                    p = p.shift();
                if (!(p instanceof Promise))
                    if (p !== this.activepromise.disconnect)
                        if (p.state && p.state()==='pending')
                            pending.push(p);
            } while(this.activepromise[cmd].length);
        }
        if (pending.length) {
            var reject_reason = this.disconnect_reject_reason || {cat:'Connection', msg:'Proxy disconnection'};
            for (var i=0; i < pending.length; i++)
                pending[i].reject(new Error(reject_reason.msg || reject_reason));
        }

        // reset the object so it can be reused
        let err = this.disconnect_reject_reason;
        this.status='closed';
        this.reset();

        // resolve the disconnect promise after all others
        return Promise.all(pending)
                .then(() => {
                    if (err) throw new Error(err.msg || err);
                });
    },

    proxy_connect : function(o) {
        var ws, port=(o&&o.port)||6037;
        try { 
            ws = new WebSocket(`ws://127.0.0.1:${port}`);
        } catch(e) {
           ws = null;
           throw new Error('A connection to the ADB proxy could not be established.');
        };

        this.ws = ws;
        this.ws.adbclient = this;
        this.status = 'connecting';

        // connected is resolved after auth has completed
        this.activepromise.connected = new Promise(resolve => {
            ws.onopen = () => {
                this.status = 'handshake';
                this.logsend('auth', 'vscadb client version 1')
                    .then(function () {
                        resolve([]);
                    });
                //this.adbclient.proxy_onopen(e);
            }
            ws.onerror = function(e) {
                clearTimeout(this.commandTimeout);
                this.adbclient.proxy_onerror(e);
            };
            ws.onmessage = function(e) {
                clearTimeout(this.commandTimeout);
                this.adbclient.proxy_onmessage(e);
            };
            this.activepromise.disconnected = new Promise((resolve, reject) => {
                ws.onclose = function (e) {
                    clearTimeout(this.commandTimeout);
                    // safari doesn't call onerror for connection failures
                    if (this.adbclient.status === 'connecting' && !this.adbclient.disconnect_reject_reason)
                        this.adbclient.proxy_onerror(e);
                    this.adbclient.proxy_onclose(e).then(resolve, reject);
                };
            });
        });

        // the first promise is always connected, resolved after auth has completed
        return this.activepromise.connected;
    },

    logsend : function(cmd, msg) {
        return new Promise((resolve, reject) => {
            const def = {resolve, reject};

            if (this.activepromise[cmd]) {
                if (Array.isArray(this.activepromise[cmd])) {
                    // already a queue - just add it
                    this.activepromise[cmd].push(def);
                } else {
                    // one pending - turn this into a queue
                    this.activepromise[cmd] = [this.activepromise[cmd], def];
                }
            } else {
                // no active entry
                this.activepromise[cmd] = def;
            }
            if (!this.ws) {
                this.proxy_disconnect_with_fail({cat:'Connection', msg:'Proxy disconnected'});
                return;
            }
            clearTimeout(this.ws.commandTimeout);
            try {
                this.ws.send(msg);
            } catch (e){
                this.proxy_disconnect_with_fail({cat:'Connection', msg:e.toString()});
                return;
            }
            var docmdtimeout = 0;// !(opts&&opts.notimeout);
            // if adb is not active, Windows takes at least 1 second to fail
            // the socket connect...
            this.ws.commandTimeout = docmdtimeout ?
                setTimeout(() => {
                    this.proxy_disconnect_with_fail({cat:'Connection', msg:'Command timeout'});
                }, 300*1000)
                : -1;
        });
    },

    dexcmd : function(cmd, fd, data, opts) {
        var msg = cmd;
        if (fd)
            msg = msg + " " + fd;
        if (data)
            msg = msg + " " + btoa(data);
        return this.logsend(cmd, msg, opts);
    },

    dexcmd_read_status : function(cmdname, cmd, fd, data, opts) {
        return this.dexcmd(cmd, fd, data)
            .then(() => this.dexcmd('rs', this.fd, opts))
            .then((data) => {
                if (data !== 'OKAY') {
                    return this.proxy_disconnect_with_fail({cat:"cmd",  msg:"Command "+ cmdname +" failed"});
                }
                return data;
            });
    },

    dexcmd_read_sync_response : function(cmdname, cmd, fd, data) {
        return this.dexcmd(cmd, fd, data)
            .then(() => this.dexcmd('rs', this.fd, '4'))
            .then(data => {
                if (data.slice(0,4) !== 'OKAY') {
                    return this.proxy_disconnect_with_fail({cat:"cmd",  msg:"Command "+ cmdname +" failed"});
                }
                return data;
            });
    },

    dexcmd_read_stdout : function(fd, untilclosed) {
        return new Promise((resolve, reject) => {
            const stdoutinfo = {
                fd: fd,
                result: '',
                untilclosed: !!untilclosed,
            }
            const readchunk = () => {
                this.dexcmd('rx', stdoutinfo.fd)
                    .then((data) => {
                        const eod = data==='nomore';
                        if (data && data.length && !eod) {
                            stdoutinfo.result += atob(data);
                        }
                        if (stdoutinfo.untilclosed && !eod) {
                            readchunk();
                            return;
                        }
                        resolve(stdoutinfo.result);
                    }, reject);
            }
            readchunk();
        });
    },

    dexcmd_write_data : function(data) {
        const dtinfo = {
            transferred: 0,
            transferring: 0,
            chunk_size: 4000,
            data,
        }

        const write_next_chunk = () => {
            dtinfo.transferred += dtinfo.transferring;
            const remaining = dtinfo.data.byteLength - dtinfo.transferred;
            if (remaining <= 0 || isNaN(remaining)) {
                return Promise.resolve(dtinfo.transferred);
            }
            const datalen = Math.min(remaining, dtinfo.chunk_size);
            let cmd = 'DATA';
            for(let i=0;i < 4; i++)
                cmd += String.fromCharCode((datalen>>(i*8))&255);

            let bytes = new Uint8Array(dtinfo.data.slice(dtinfo.transferred, dtinfo.transferred + datalen));
            for(let i = 0; i < bytes.length; i++)
                cmd += String.fromCharCode(bytes[i]);
            bytes = null;
            dtinfo.transferring = datalen;
            
            return this.dexcmd('wx', this.fd, cmd)
                .then(() => write_next_chunk())
        }
        return write_next_chunk();
    },

};

exports.ADBClient = ADBClient;
