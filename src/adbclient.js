/*
    ADBClient: class to manage connection and commands to adb (via the Dex plugin) running on the local machine.
*/
const _JDWP = require('./jdwp')._JDWP;
const $ = require('./jq-promise');
const WebSocket = require('./minwebsocket').WebSocketClient;
const { atob,btoa,D } = require('./util');

function ADBClient(deviceid) {
    this.deviceid = deviceid;
    this.status = 'notinit';
    this.reset();
    this.JDWP = new _JDWP();
}

ADBClient.prototype = {

    reset : function() {
        this.ws = null;
        this.activepromise={};
        this.authdone=false;
        this.fd=-1;
        this.disconnect_reject_reason=null;
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
        var x = {o:o||{},deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('track_devices', 'wa', this.fd, 'host:track-devices-extended');
            })
            .then(function(data) {
                return this.dexcmd('ra', this.fd);
            })
            .then(function(data) {
                function nextdeviceinfo(data) {
                    this.dexcmd('ra', this.fd, null, {notimeout:true})
                        .then(nextdeviceinfo);
                    var devicelist = this._parse_device_list(data, true);
                    x.o.ondevices(devicelist, this);
                }
                nextdeviceinfo.call(this, data);
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    finish_track_devices : function() {
        return this.dexcmd('dc', this.fd)
            .then(function() {
                return this.proxy_disconnect();
            });
    },

    test_adb_connection : function(o) {
        var x = {o:o||{},deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [null, x.o.extra]);
            })
            .fail(function(err) {
                // if we fail, still resolve the deferred, passing the error
                x.deferred.resolveWith(x.o.ths||this, [err, x.o.extra]);
            });
        return x.deferred;
    },

    list_devices : function(o) {
        var x = {o:o||{},deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('list_devices', 'wa', this.fd, 'host:devices');
            })
            .then(function(data) {
                return this.dexcmd('ra', this.fd);
            })
            .then(function(data) {
                x.devicelist = this._parse_device_list(data);
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [x.devicelist, x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    jdwp_list : function(o) {
        var x = {o:o||{},deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('set_transport', 'wa', this.fd, 'host:transport:'+this.deviceid);
            })
            .then(function(data) {
                return this.dexcmd_read_status('jdwp', 'wa', this.fd, 'jdwp');
            })
            .then(function(data) {
                return this.dexcmd_read_stdout(this.fd);
            })
            .then(function(data) {
                this.stdout = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [this.stdout.trim().split(/\r?\n|\r/g), x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    jdwp_forward : function(o) {
        // localport:1234
        // jdwp:1234
        var x = {o:o,deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('forward', 'wa', this.fd, 'host-serial:'+this.deviceid+':forward:tcp:'+x.o.localport+';jdwp:'+x.o.jdwp)
            })
            .then(function(data) {
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    forward_remove_all : function(o) {
        var x = {o:o||{},deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('forward_remove_all', 'wa', this.fd, 'host:killforward-all');
            })
            .then(function(data) {
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    jdwp_connect : function(o) {
        // {localport:1234, onreply:fn()}
        // note that upon success, this method does not close the connection
        var x = {o:o,deferred:$.Deferred()};
        this.jdwpinfo = {
            o: o,
            localport: o.localport,
            onreply: o.onreply,
            received: [],
        };
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cp', o.localport);
            })
            .then(function(data) {
                this.jdwpfd = data;
                return this.dexcmd('wx', this.jdwpfd, 'JDWP-Handshake');
            })
            .then(function(data) {
                return this.dexcmd_read_stdout(this.jdwpfd);
            })
            .then(function(data) {
                if (data!=='JDWP-Handshake') {
                    // disconnect and fail
                    return this.dexcmd('dc', this.jdwpfd)
                        .then(function() {
                            return this.proxy_disconnect_with_fail({cat:'jdwp', msg:'Invalid handshake response'});
                        });
                }
                // start the monitor - we don't want it terminated on timeout
                return this.logsend('rj', 'rj '+this.jdwpfd, {notimeout:true});
            })
            .then(function() {
                // the first rj reply is a blank ok message indicating the monitor
                // has started
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    jdwp_command : function(o) {
        // cmd: JDWP.Command
        // resolveonreply: true/false
        
        // send the raw command over the socket - the reply
        // is received via the JDWP monitor
        var x = {o:o,deferred:$.Deferred()};
        this.dexcmd('wx', this.jdwpfd, o.cmd.toRawString())
            .fail(function(err) {
                o.cmd.deferred.rejectWith(o.ths||this, [err]);
            });

        o.cmd.deferred
            .then(function(decoded,reply,command) {
                x.deferred.resolveWith(x.o.ths||this, [decoded,x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });

        return x.deferred;
    },

    jdwp_disconnect : function(o) {
        var x = {o:o,deferred:$.Deferred()};
        this.dexcmd('dc', this.jdwpfd)
            .then(function() {
                delete this.jdwpfd;
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    readwritesocket : function(o) {
        var x = {o:o,deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd('qs', this.fd, ''+o.port+':'+o.readlen+':'+o.data);
            })
            .then(function(data) {
                this.socket_reply = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [this.socket_reply, x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    shell_cmd : function(o) {
        // command='ls /'
        // untilclosed=true
        var x = {o:o,deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('set_transport', 'wa', this.fd, 'host:transport:'+this.deviceid);
            })
            .then(function(data) {
                return this.dexcmd_read_status('shell_cmd', 'wa', this.fd, 'shell:'+x.o.command);
            })
            .then(function(data) {
                return this.dexcmd_read_stdout(this.fd, !!x.o.untilclosed);
            })
            .then(function(data) {
                this.stdout = data;
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [this.stdout, x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    logcat : function(o) {
        // onlog:function(e)
        // onclose:function(e)
        // data:anything
        var x = {o:o,deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('set_transport', 'wa', this.fd, 'host:transport:'+this.deviceid);
            })
            .then(function(data) {
                return this.dexcmd_read_status('shell_cmd', 'wa', this.fd, 'shell:logcat -v time');
            })
            .then(function(data) {
                // if there's no handler, just read the complete log and finish
                if (!o.onlog) {
                    return this.dexcmd_read_stdout(this.fd)
                        .then(function(data) {
                            this.logcatbuffer = data;
                            return this.dexcmd('dc', this.fd);
                        })
                        .then(function() {
                            return this.proxy_disconnect();
                        })
                        .then(function() {
                            x.deferred.resolveWith(x.o.ths||this, [this.logcatbuffer, x.o.extra]);
                        });
                }

                // start the logcat monitor
                return this.dexcmd('so', this.fd)
                    .then(function() {
                        this.logcatinfo = {
                            deferred: x.deferred,
                            buffer: '',
                            onlog: o.onlog||(()=>{}),
                            onlogdata: o.data,
                            onclose: o.onclose||(()=>{}),
                            fd: this.fd,
                            waitfn:_waitfornextlogcat,
                        }
                        this.logcatinfo.waitfn.call(this);
                        function _waitfornextlogcat() {
                            // create a new promise for when the next message is received
                            this.activepromise.so = $.Deferred();
                            this.activepromise.so
                                .then(function(data) {
                                    var decodeddata = atob(data);
                                    if (decodeddata === 'eoso:d10d9798-1351-11e5-bdd9-5b316631f026') {
                                        this.logcatinfo.fd=0;
                                        this.proxy_disconnect().always(function() {
                                            var e = {adbclient:this, data:this.logcatinfo.onlogdata};
                                            this.logcatinfo.onclose.call(this, e);
                                            if (this.logcatinfo.end) {
                                                var x = this.logcatinfo.end;
                                                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
                                            }
                                        });
                                        return;
                                    }
                                    var s = this.logcatinfo.buffer + atob(data);
                                    var sp = s.split(/\r\n?|\n/);
                                    if (/[\r\n]$/.test(s)) {
                                        this.logcatinfo.buffer = ''
                                    } else {
                                        this.logcatinfo.buffer = sp.pop();
                                    }
                                    var e = {adbclient:this, data:this.logcatinfo.onlogdata, logs:sp};
                                    this.logcatinfo.onlog.call(this, e);
                                    this.logcatinfo.waitfn.call(this);
                                });
                        }
                        // resolve the promise to indicate that logging has started
                        return x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
                    });
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    endlogcat : function(o) {
        var x = {o:o||{},deferred:$.Deferred()};
        var logcatfd = this.logcatinfo && this.logcatinfo.fd;
        if (!logcatfd)
                return x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
        this.logcatinfo.fd = 0;
        this.logcatinfo.end = x;

        // close the connection - the monitor callback will resolve the promise
        this.dexcmd('dc', logcatfd);
        return x.deferred;
    },

    push_file : function(o) {
        // filepathname='/data/local/tmp/fname'
        // filedata:<arraybuffer>
        // filemtime:12345678
        this.push_file_info = o;
        var x = {o:o,deferred:$.Deferred()};
        this.proxy_connect()
            .then(function() {
                return this.dexcmd('cn');
            })
            .then(function(data) {
                this.fd = data;
                return this.dexcmd_read_status('set_transport', 'wa', this.fd, 'host:transport:'+this.deviceid);
            })
            .then(function(data) {
                return this.dexcmd_read_status('sync', 'wa', this.fd, 'sync:');
            })
            .then(function() {
                var perms = '33204';
                var cmddata = this.push_file_info.filepathname+','+perms;
                var cmd='SEND'+String.fromCharCode(cmddata.length)+'\0\0\0'+cmddata;
                return this.dexcmd('wx', this.fd, cmd)
            })
            .then(function(data) {
                return this.dexcmd_write_data(this.push_file_info.filedata);
            })
            .then(function(data) {
                var cmd='DONE';
                var mtime = this.push_file_info.filemtime;
                for(var i=0;i < 4; i++)
                    cmd+= String.fromCharCode((mtime>>(i*8))&255);
                return this.dexcmd_read_sync_response('done', 'wx', this.fd, cmd);
            })
            .then(function(data) {
                this.progress = 'quit';
                var cmd='QUIT\0\0\0\0';
                return this.dexcmd('wx', this.fd, cmd);
            })
            .then(function(data) {
                return this.dexcmd('dc', this.fd);
            })
            .then(function() {
                return this.proxy_disconnect();
            })
            .then(function() {
                x.deferred.resolveWith(x.o.ths||this, [x.o.extra]);
            })
            .fail(function(err) {
                x.deferred.rejectWith(x.o.ths||this, [err]);
            });
        return x.deferred;
    },

    do_auth : function(msg) {
        var m = msg.match(/^vscadb proxy version 1/);
        if (m) {
            this.authdone = true;
            this.status='connected';
            return this.activepromise.auth.resolveWith(this, []);
        }
        return this.proxy_disconnect_with_fail({cat:"Authentication", msg:"Proxy handshake failed"});
    },

    proxy_disconnect_with_fail : function(reason) {
        this.disconnect_reject_reason = reason;
        return this.proxy_disconnect();
    },

    proxy_disconnect : function() {
        this.ws&&this.ws.close();
        return this.activepromise.disconnect;
    },

    proxy_onopen : function() {
        this.status='handshake';
        this.logsend('auth','vscadb client version 1')
            .then(function(){
                this.activepromise.connected.resolveWith(this, []);
            });
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
                process.nextTick(function() {
                    while (this.jdwpinfo.received.length) {
                        var nextdata = this.jdwpinfo.received.shift();
                        this.jdwpinfo.onreply.call(this.jdwpinfo.o.ths||this, atob(nextdata));
                    }
                }.bind(this));
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
                p.resolveWith(this, [e.data.substring(6)]);
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

    proxy_onclose : function(e) {
        // when disconnecting, reject any pending promises first
        var pending = [];
        for (var cmd in this.activepromise) {
            do {
                var p = this.activepromise[cmd];
                if (!p) break;
                if (Array.isArray(p))
                    p = p.shift();
                if (p !== this.activepromise.disconnect)
                    if (p.state()==='pending')
                        pending.push(p);
            } while(this.activepromise[cmd].length);
        }
        if (pending.length) {
            var reject_reason = this.disconnect_reject_reason || {cat:'Connection', msg:'Proxy disconnection'};
            for (var i=0; i < pending.length; i++)
                pending[i].rejectWith(this, [reject_reason]);
        }

        // reset the object so it can be reused
        var dcinfo = {
            client: this,
            deferred: this.activepromise.disconnect,
            reason: this.disconnect_reject_reason
        };
        this.status='closed';
        this.reset();

        // resolve the disconnect promise after all others
        pending.unshift(dcinfo);
        $.when.apply($, pending)
            .then(function(dcinfo) {
                if (dcinfo.reason)
                    dcinfo.deferred.rejectWith(dcinfo.client, [dcinfo.reason]);
                else
                    dcinfo.deferred.resolveWith(dcinfo.client);
            });
    },

    proxy_connect : function(o) {
        var ws, port=(o&&o.port)||6037;
        try { 
            ws = new WebSocket('ws://127.0.0.1:'+port);
        } catch(e) {
           ws=null;
           return $.Deferred().rejectWith(this, [new Error('A connection to the ADB proxy could not be established.')]);
        };

        this.ws = ws;
        this.ws.adbclient = this;
        this.status='connecting';
        // connected is resolved after auth has completed
        this.activepromise.connected = $.Deferred();
        // disconnect is resolved when the websocket is closed
        this.activepromise.disconnect = $.Deferred();

        ws.onopen = function(e) {
            this.adbclient.proxy_onopen(e);
        }
        ws.onerror = function(e) {
            clearTimeout(this.commandTimeout);
            this.adbclient.proxy_onerror(e);
        };
        ws.onmessage = function(e) {
            clearTimeout(this.commandTimeout);
            this.adbclient.proxy_onmessage(e);
        };
        ws.onclose = function(e) {
            clearTimeout(this.commandTimeout);
            // safari doesn't call onerror for connection failures
            if (this.adbclient.status==='connecting' && !this.adbclient.disconnect_reject_reason)
                this.adbclient.proxy_onerror(e);
            this.adbclient.proxy_onclose(e);
        };

        // the first promise is always connected, resolved after auth has completed
        return this.activepromise.connected.promise();
    },

    logsend : function(cmd, msg, opts) {
        var def = $.Deferred();
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
            return def;
        }
        clearTimeout(this.ws.commandTimeout);
        try {
            this.ws.send(msg);
        } catch (e){
            this.proxy_disconnect_with_fail({cat:'Connection', msg:e.toString()});
            return def;
        }
        var docmdtimeout = 0;// !(opts&&opts.notimeout);
        // if adb is not active, Windows takes at least 1 second to fail
        // the socket connect...
        this.ws.commandTimeout = docmdtimeout ?
            setTimeout(function(adbclient) {
               adbclient.proxy_disconnect_with_fail({cat:'Connection', msg:'Command timeout'});
            }, 300*1000, this)
            : -1;

        return def;
    },

    dexcmd : function(cmd, fd, data, opts) {
        var msg = cmd;
        if (fd)
            msg = msg + " " + fd;
        if (data)
            msg = msg + " " + btoa(data);
        return this.logsend(cmd, msg, opts);
    },

    dexcmd_read_status : function(cmdname, cmd, fd, data) {
        return this.dexcmd(cmd, fd, data)
            .then(function() {
                  return this.dexcmd('rs', this.fd);
            })
            .then(function(data) {
                if (data !== 'OKAY') {
                    return this.proxy_disconnect_with_fail({cat:"cmd",  msg:"Command "+ cmdname +" failed"});
                }
                return data;
            });
    },

    dexcmd_read_sync_response : function(cmdname, cmd, fd, data) {
        return this.dexcmd(cmd, fd, data)
            .then(function() {
                  return this.dexcmd('rs', this.fd, '4');
            })
            .then(function(data) {
                if (data.slice(0,4) !== 'OKAY') {
                    return this.proxy_disconnect_with_fail({cat:"cmd",  msg:"Command "+ cmdname +" failed"});
                }
                return data;
            });
    },

    dexcmd_read_stdout : function(fd, untilclosed) {
        this.stdoutinfo = {
            fd: fd,
            result:'',
            untilclosed:untilclosed||false,
            deferred: $.Deferred(),
        }
        function readchunk() {
            this.dexcmd('rx', this.stdoutinfo.fd)
                .then(function(data) {
                    var eod = data==='nomore';
                    if (data && data.length && !eod) {
                        this.stdoutinfo.result += atob(data);
                    }
                    if (this.stdoutinfo.untilclosed && !eod) {
                        readchunk.call(this);
                        return;
                    }
                    var info = this.stdoutinfo;
                    delete this.stdoutinfo;
                    info.deferred.resolveWith(this, [info.result]);
                })
                .fail(function(err) {
                    var info = this.stdoutinfo;
                    delete this.stdoutinfo;
                    info.deferred.rejectWith(this, [err]);
                });
        }
        readchunk.call(this);
        return this.stdoutinfo.deferred.promise();
    },

    dexcmd_write_data : function(data) {
        this.dtinfo = {
            transferred: 0,
            transferring: 0,
            data: data,
            deferred: $.Deferred(),
        }

        function writechunk() {
            this.dtinfo.transferred += this.dtinfo.transferring;
            var remaining = this.dtinfo.data.byteLength-this.dtinfo.transferred;
            if (remaining <= 0 || isNaN(remaining)) {
                var info = this.dtinfo;
                delete this.dtinfo;
                info.deferred.resolveWith(this, [info.transferred]);
                return;
            }
            var datalen=remaining;
            if (datalen > 4000) datalen=4000;
            var cmd='DATA';
            for(var i=0;i < 4; i++)
                cmd+= String.fromCharCode((datalen>>(i*8))&255);
            var bytes = new Uint8Array(this.dtinfo.data.slice(this.dtinfo.transferred, this.dtinfo.transferred+datalen));
            for(var i=0;i < bytes.length; i++)
                cmd+= String.fromCharCode(bytes[i]);
            bytes = null;
            this.dtinfo.transferring = datalen;
            this.dexcmd('wx', this.fd, cmd)
                .then(function(data) {
                    writechunk.call(this);
                })
                .fail(function(err) {
                    var info = this.dtinfo;
                    delete this.dtinfo;
                    info.deferred.rejectWith(this, [err]);
                });
        }
        writechunk.call(this);
        return this.dtinfo.deferred.promise();
    },

};

exports.ADBClient = ADBClient;
