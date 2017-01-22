const chrome = require('./chrome-polyfill').chrome;
const { create_chrome_socket, destroy_chrome_socket } = chrome;
const { D, remove_from_list } = require('./util');

// array of local_sockets
var _local_sockets = [];

var _new_local_socket_id = 1000;
var new_local_socket = function(t, fd, close_fd_on_local_socket_close) {
    var x = {
        id:++_new_local_socket_id,
        fd:fd,
        close_fd_on_local_socket_close: !!close_fd_on_local_socket_close,
        transport:t,
        enqueue: local_socket_enqueue,
        ready: local_socket_ready_notify,
        close: local_socket_close,
        peer:null,
        //socketbuffer: [],
    }
    _local_sockets.push(x);
    return x;
}

var find_local_socket = function(local_socket_id, peer_socket_id) {
    for (var i=0; i < _local_sockets.length; i++) {
        var ls = _local_sockets[i];
        if (ls.id === local_socket_id) {
            if (!peer_socket_id) return ls;
            if (!ls.peer) continue;
            if (ls.peer.id === peer_socket_id) return ls;
        }
    }
    return null;
}

var local_socket_ready = function(s) {
    D("LS(%d): ready()\n", s.id);
}

var local_socket_ready_notify = function(s) {
    s.ready = local_socket_ready;
    send_okay(s.fd);
    s.ready(s);
}

var local_socket_enqueue = function(s, p) {
    D("LS(%d): enqueue()\n", s.id, p.len);

    if (s.fd.closed) return false;

    D("LS: enqueue() - writing %d bytes to fd:%d %o\n", p.len, s.fd.n, s.fd);
    adb_writebytes(s.fd, p.data, p.len);
    //s.socketbuffer.push({data:p.data, len:p.len});
    return true;
}

var local_socket_close = function(s) {
    // flush the data to the output socket
    /*var totallen = s.socketbuffer.reduce(function(n, x) { return n+x.len },0);
    adb_writebytes(s.fd, intToHex(totallen,4));
    s.socketbuffer.forEach(function(x) {
        adb_writebytes(s.fd, x.data, x.len);
    });*/

    if (s.peer) {
        s.peer.peer = null;
        s.peer.close(s.peer);
        s.peer = null;
    }

    if (s.fd && s.close_fd_on_local_socket_close) {
        s.fd.close();
    }

    var id = s.id;
    var idx = _local_sockets.indexOf(s);
    if (idx >= 0) _local_sockets.splice(idx, 1);
    D("LS(%d): closed()\n", id);
}

var local_socket_force_close_all = function(t) {
    // called when a transport disconnects without a clean finish
    var lsarr = _local_sockets.reduce(function(res, ls) {
        if (ls && ls.transport === t) res.push(ls);
        return res;
    }, []);
    lsarr.forEach(function(ls) {
        D('force closing socket: %o', ls);
        local_socket_close(ls);
    });
}

var remote_socket_ready = function(s, cb) {
    D("entered remote_socket_ready RS(%d) OKAY fd=%d peer.fd=%d\n",
      s.id, s.fd, s.peer.fd);
    p = get_apacket();
    p.msg.command = A_OKAY;
    p.msg.arg0 = s.peer.id;
    p.msg.arg1 = s.id;
    send_packet(p, s.transport, cb);
}

var remote_socket_close = function(s) {
    if (s.peer) {
        s.peer.peer = null;
        s.peer.close(s.peer);
    }
    D("RS(%d): closed\n", s.id);
}

var create_remote_socket = function(id, t) {
    var s = {
        id: id,
        transport: t,
        peer:null,
        ready: remote_socket_ready,
        close: remote_socket_close,

        // a remote socket is a normal socket with an extra disconnect function
        disconnect:null,
    }
     D("RS(%d): created\n", s.id);

     // when a
     return s;
}


var loopback_clients = [];

var get_socket_fd_from_fdn = exports.get_socket_fd_from_fdn = function(n) {
    for (var i=0; i < loopback_clients.length; i++) {
        if (loopback_clients[i].n === n)
            return loopback_clients[i];
    }
    return null;
}

var socket_loopback_client = exports.socket_loopback_client = function(port, cb) {
    create_chrome_socket('socket_loopback_client', function(createInfo) {
        chrome.socket.connect(createInfo.socketId, '127.0.0.1', port, function(result) {
            if (result < 0) {
                destroy_chrome_socket(createInfo.socketId);
                return cb();
            }
            chrome.socket.setNoDelay(createInfo.socketId, true, function(result) {
                var x = new_socketfd(createInfo.socketId);
                return cb(x);
            });
        });
    });
}

var new_socketfd = exports.new_socketfd = function(socketId) {
    var x = {
        n: socketId,
        isSocket:true,
        connected:true,
        closed:false,
        // readbytes and writebytes are used by readx and writex
        readbytes:function(len, cb) {
            slc_read(this, len, function(err, data){
                cb(err, data);
            });
        },
        writebytes:function(data, cb) {
            slc_write(this, data, cb||function(){});
        },
        close:function() {
            slc_close(this, function(){});
        }
    };
    loopback_clients.push(x);
    return x;
}

var slc_readwithkick = function(sfd, cb) {

    /*if (sfd.reader_cb_stack.length) {
        return cb(null, new Uint8Array(0));
    }*/

    //var readinfo = {cb:cb, expired:false};
    //sfd.reader_cb_stack.push(readinfo);

    var kicker = setTimeout(function() {
        if (!kicker) return;
        kicker = null;
        D('reader kick expired - retuning nothing');
        //readinfo.expired = true;
        cb(null, new Uint8Array(0));
    }, 100);

    slc_read_stacked_(sfd, function(err, data) {
        if (!kicker) {
            D('Discarding data recevied after kick expired');
            return;
        }
        clearTimeout(kicker);
        kicker = null;
        cb(err, data);
    });
};

var slc_read = function(sfd, minlen, cb) {
    //sfd.reader_cb_stack.push({cb:cb, expired:false});
    slc_read_stacked_(sfd, minlen, cb);
}

var slc_read_stacked_ = function(sfd, minlen, cb) {
    var params = [sfd.n];
    switch(typeof(minlen)) {
        case 'number': params.push(minlen); break;
        case 'function': cb = minlen; // fall through
        default: minlen = 'any';
    };
    var buffer = new Uint8Array(minlen==='any'?65536:minlen);
    var buffer_offset = 0;
    var onread = function(readInfo) {
        if (chrome.runtime.lastError) {
            slc_close(sfd, function() {
                cb({msg: 'socket read error. Terminating socket'});
            });
            return;
        }
        if (readInfo.resultCode < 0) return cb(readInfo);

        buffer.set(new Uint8Array(readInfo.data), buffer_offset);
        buffer_offset += readInfo.data.byteLength;
        if (typeof(minlen)==='number' &&buffer_offset < minlen) {
            // read more
            params[1] = minlen - buffer_offset;
            chrome.socket.read.apply(chrome.socket, params);
            return;
        }
        buffer = buffer.subarray(0, buffer_offset);
        buffer.asString = function() { return arrayBufferToString(this); }
        return cb(null, buffer);
    };
    params.push(onread);
    chrome.socket.read.apply(chrome.socket, params);
}

var slc_write = function(sfd, data, cb) {
    var buf = data.buffer;
    if (buf.byteLength !== data.byteLength) {
        buf = buf.slice(0, data.byteLength);
    }
    chrome.socket.write(sfd.n, buf, function(writeInfo) {
        if (chrome.runtime.lastError) {
            slc_close(sfd, function() {
                cb({msg: 'socket write error. Terminating socket'});
            });
            return;
        }
        if (writeInfo.bytesWritten !== data.byteLength) 
            return cb({msg: 'socket write mismatch. wanted:'+data.byteLength+', sent:'+writeInfo.bytesWritten});
        cb();
    });
}

var slc_shutdown = function(sfd, cb) {
    if (sfd.connected) {
        sfd.connected = false;
        chrome.socket.disconnect(sfd.n);
    }
    cb();
}

var slc_close = function(sfd, cb) {
    if (sfd.connected) {
        sfd.connected = false;
        chrome.socket.disconnect(sfd.n);
    }
    sfd.closed = true;
    destroy_chrome_socket(sfd.n);
    remove_from_list(loopback_clients, sfd);
    cb();
}


var fd_loopback_client = function() {
    var s = [];
    adb_socketpair(s, 'fd_loopback_client', true);
    D('fd_loopback_client created. server fd:%d, client fd:%d', s[1].n, s[0].n);
    // return one side and pass the other side to the request handler
    start_request(s[1]);
    return s[0];
}
