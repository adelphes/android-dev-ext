const net = require('net');
const D = require('./util').D;

var sockets_by_id = {};
var last_socket_id = 0;

const chrome = {
    storage: {
        local: {
            q:{},
            get(o, cb) {
                for (var key in o) {
                    var x = this.q[key];
                    if (typeof(x) !== 'undefined') o[key] = x;
                }
                process.nextTick(cb, o);
            },
            set(obj, cb) {
                for (var key in obj)
                    this.q[key] = obj[key];
                process.nextTick(cb);
            }
        }
    },
    runtime: {
        lastError:null,
        _noError() { this.lastError = null }
    },
    permissions: {
        request(usbPermissions, cb) {
            process.nextTick(cb, true);
        }
    },
    socket: {
        listen(socketId, host, port, max_connections, cb) {
            var s = sockets_by_id[socketId];
            s._raw.listen(port, host, max_connections);
            process.nextTick(cb => {
                chrome.runtime._noError();
                cb(0);
            }, cb);
        },
        connect(socketId, host, port, cb) {
            var s = sockets_by_id[socketId];
            s._raw.connect({port:port,host:host}, function(){
                chrome.runtime._noError();
                this.s.onerror = null;
                this.cb.call(null,0);
            }.bind({s:s,cb:cb}));
            s.onerror = function(e) {
                this.s.onerror = null;
                this.cb.call(null,-1);
            }.bind({s:s,cb:cb});
        },
        disconnect(socketId) {
            var s = sockets_by_id[socketId];
            s._raw.end();
        },
        setNoDelay(socketId, state, cb) {
            var s = sockets_by_id[socketId];
            s._raw.setNoDelay(state);
            process.nextTick(cb => {
                chrome.runtime._noError();
                cb(1);
            }, cb);
        },
        read(socketId, bufferSize, onRead) {
            if (!onRead && typeof(bufferSize) === 'function')
                onRead = bufferSize, bufferSize=-1;
            if (!onRead) return;
            var s = sockets_by_id[socketId];
            if (bufferSize === 0) {
                process.nextTick(function(onRead) {
                    chrome.runtime._noError();
                    onRead.call(null, {resultCode:1,data:Buffer.alloc(0)});
                }, onRead);
                return;
            }
            s.read_requests.push({onRead:onRead, bufferSize:bufferSize});
            if (s.read_requests.length > 1) {
                return;
            }
            !s.ondata && s._raw.on('data', s.ondata = function(data) {
                this.readbuffer = Buffer.concat([this.readbuffer, data]);
                while(this.read_requests.length) {
                    var amount = this.read_requests[0].bufferSize;
                    if (amount <= 0) amount = this.readbuffer.length;
                    if (amount > this.readbuffer.length || this.readbuffer.length === 0)
                        return; // wait for more data
                    var readInfo = {
                        resultCode:1,
                        data:Buffer.from(this.readbuffer.slice(0,amount)),
                    };
                    this.readbuffer = this.readbuffer.slice(amount);
                    chrome.runtime._noError();
                    this.read_requests.shift().onRead.call(null,readInfo);
                }
                this.onerror = this.onclose = null;
            }.bind(s));
            var on_read_terminated = function(e) {
                this.readbuffer = Buffer.alloc(0);
                while(this.read_requests.length) {
                    var readInfo = {
                        resultCode:-1,   // <=0 for error
                    };
                    this.read_requests.shift().onRead.call(null,readInfo);
                }
                this.onerror = this.onclose = null;
            }.bind(s);
            !s.onerror && (s.onerror = on_read_terminated);
            !s.onclose && (s.onclose = on_read_terminated);
            if (s.readbuffer.length || bufferSize < 0) {
                process.nextTick(s.ondata, Buffer.alloc(0));
            }
        },
        write(socketId, data, cb) {
            var s = sockets_by_id[socketId];
            if (!(data instanceof Buffer))
                data = Buffer.from(data);
            s._raw.write(data, function(e,f,g) {
                if (this.s.write_cbs.length === 1)
                    this.s.onerror = null;
                var writeInfo = {
                    bytesWritten: this.len,
                };
                chrome.runtime._noError();
                this.s.write_cbs.shift().call(null, writeInfo);
            }.bind({s:s,len:data.length,cb:cb}));
            s.write_cbs.push(cb);
            if (!s.onerror) {
                s.onerror = function(e) {
                    this.s.onerror = null;
                    while (this.s.write_cbs.length) {
                        var writeInfo = {
                            bytesWritten: 0,
                        };
                        this.s.write_cbs.shift().call(null, writeInfo);
                    }
                }.bind({s:s});
            }
        },
    },

    create_socket:function(id, type, cb) {
        if (!cb && typeof(type) === 'function') {
            cb = type, type = null;
        }
        var socket = type === 'server' ? new net.Server() : new net.Socket();
        var socketInfo = {
            id: id,
            socketId: ++last_socket_id,
            _raw: socket,
            onerror:null,
            onclose:null,
            write_cbs:[],
            read_requests:[],
            readbuffer:Buffer.alloc(0),
        };
        socketInfo._raw.on('error', function(e) {
            chrome.runtime.lastError = e;
            this.onerror && this.onerror(e);
        }.bind(socketInfo));
        socketInfo._raw.on('close', function(e) {
            this.onclose && this.onclose(e);
        }.bind(socketInfo));
        sockets_by_id[socketInfo.socketId] = socketInfo;
        process.nextTick(cb, socketInfo);
    },
    create_chrome_socket(id, type, cb) { return chrome.create_socket(id, type, cb) },

    accept_socket:function(id, socketId, cb) {
        var s = sockets_by_id[socketId];
        if (s.onconnection) {
            s.onconnection = cb;
        } else {
            s.onconnection = cb;
            s._raw.on('connection', function(client_socket) {
                var acceptInfo = {
                    socketId: ++last_socket_id,
                    _raw: client_socket,
                }
                sockets_by_id[acceptInfo.socketId] = acceptInfo;
                this.onconnection(acceptInfo);
            }.bind(s));
        }
    },
    accept_chrome_socket(id, socketId, cb) { return chrome.accept_socket(id, socketId, cb) },

    destroy_socket:function(socketId) {
        var s = sockets_by_id[socketId];
        if (!s) return;
        s._raw.end();
        sockets_by_id[socketId] = null;
    },
    destroy_chrome_socket(socketId) { return chrome.destroy_socket(socketId) },
}

exports.chrome = chrome;
