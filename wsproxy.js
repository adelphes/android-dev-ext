const WebSocketServer = require('./minwebsocket').WebSocketServer;
const { atob, btoa, ab2str, str2u8arr, arrayBufferToString, intFromHex, intToHex, D,E,W, get_file_fd_from_fdn } = require('./util');
const { connect_forward_listener } = require('./services');
const { get_socket_fd_from_fdn, socket_loopback_client } = require('./sockets');
const { readx, writex } = require('./transport');

var dprintfln = ()=>{};//D;
WebSocketServer.DEFAULT_ADB_PORT = 5037;

var proxy = {

    Server: function(port, adbport) {
        // Listen for websocket connections.
        var wsServer = new WebSocketServer(port);
        wsServer.adbport = adbport;
        wsServer.setADBPort = function(port) {
          if (typeof(port) === 'undefined')
            return this.adbport = WebSocketServer.DEFAULT_ADB_PORT;
          return this.adbport = port;
        }

        // A list of connected websockets.
        var connectedSockets = [];

        function indexof_connected_socket(socketinfo) {
            if (!socketinfo) return -1;
            for (var i=0; i < connectedSockets.length; i++)
            if (connectedSockets[i] === socketinfo)
                return i;
            return -1;
        }

        wsServer.onconnection = function(req) {

            var ws = req.accept(); 
            var si = {
                wsServer: wsServer,
                ws: ws,
                fn: check_client_version,
                fdarr: [],
            };
            connectedSockets.push(si);

            ws.onmessage = function(e) {
                si.fn(si, e);
            };

            // When a socket is closed, remove it from the list of connected sockets.
            ws.onclose = function() {
                while (si.fdarr.length) {
                    si.fdarr.pop().close();
                }
                var idx = indexof_connected_socket(si);
                if (idx>=0) connectedSockets.splice(idx, 1);
                else D('Cannot find disconnected socket in connectedSockets');
            };

            return true;
        };

        D('WebSocketServer started. Listening on port: %d', port);

        return wsServer;
    }
}

var check_client_version = function(si, e) {
  if (e.data !== 'vscadb client version 1') {
    D('Wrong client version: ', e.data);
    return end_of_connection(si);
  }
  si.fn = handle_proxy_command;
  si.ws.send('vscadb proxy version 1');
}

var end_of_connection = function(si) {
  if (!si || !si.ws) return;
  si.ws.close();
}

var handle_proxy_command = function(si, e) {
  if (!e || !e.data || e.data.length<2) return end_of_connection(si);
  var cmd = e.data.slice(0,2);
  var fn = proxy_command_fns[cmd];
  if (!fn) {
    E('Unknown command: %s', e.data);
    return end_of_connection(si);
  }
  fn(si, e);
}

function end_of_command(si, respfmt) {
  if (!si || !si.ws || !respfmt) return;
  // format the response - we allow %s, %d and %xX
  var response = respfmt;
  var fmtidx = 0;
  for (var i=2; i < arguments.length; i++) {
    var fmt = response.slice(fmtidx).match(/%([sdxX])/);
    if (!fmt) break;
    response = [response.slice(0,fmt.index),arguments[i],response.slice(fmt.index+2)];
    switch(fmt[1]) {
        case 'x': response[1] = response[1].toString(16).toLowerCase(); break;
        case 'X': response[1] = response[1].toString(16).toUpperCase(); break;
    }
    response = response.join('');
    fmtidx = fmt.index + arguments[i].length;
  }
  si.ws.send(response);
}

function readsckt(fd, n, cb) {
  readx(fd, n, cb);
}

function write_adb_command(fd, cmd) {
  dprintfln('write_adb_command: %s',cmd);
  // write length in hex first
  writex(fd, intToHex(cmd.length, 4));
  // then the command
  writex(fd, cmd);
}

function read_adb_status(adbfd, extra, cb) {

	// read back the status
	readsckt(adbfd, 4+extra, function(err, data) {
	  if (err) return cb();
	  var status = ab2str(data);
      dprintfln("adb status: %s", status);
      cb(status);
	});
}

function read_adb_reply(adbfd, b64encode, cb) {

  // read reply length
  readsckt(adbfd, 4, function(err, data) {
    if (err) return cb();
    var n = intFromHex(ab2str(data));
    dprintfln("adb expected reply: %d bytes", n);
    // read reply
    readsckt(adbfd, n, function(err, data) {
      if (err) return cb();
      var n = data.byteLength;
      dprintfln("adb reply: %d bytes", n);
      var response = ab2str(data);
      if (n === 0) response = '\n'; // always send something
      dprintfln("%s",response);	   
      if (b64encode) response = btoa(response);
      return cb(response); 
    });
  });
}

const min_fd_num = 1000;
var fdn_to_fd = function(n) {
  var fd;
  if (n >= min_fd_num) fd = get_file_fd_from_fdn(n);
	else fd = get_socket_fd_from_fdn(n);
  if (!fd) throw new Error('Invalid file descriptor number: '+n);
	return fd;
}

var retryread = function(fd, len, cb) {
  fd.readbytes(len, cb);
}

var retryreadfill = function(fd, len, cb) {
  var buf = new Uint8Array(len);
  var totalread = 0;
  var readmore = function(amount) {
    fd.readbytes(amount, function(err, data) {
      if (err) return cb(err);
      buf.set(data, totalread);
      totalread += data.byteLength;
      var diff = len - totalread;
      if (diff > 0) return readmore(diff);
      cb(err, buf);
    });
  };
  readmore(len);
}

var be2le = function(buf) {
  var x = new Uint8Array(buf);
  var a = x[0];
  a = (a<<8)+x[1];
  a = (a<<8)+x[2];
  a = (a<<8)+x[3];
  return a;
}

var jdwpReplyMonitor = function(fd, si, packets) {
  if (!packets) {
    packets = 0;
    dprintfln("jdwpReplyMonitor thread started. jdwpfd:%d.", fd.n);
  }

  //dprintfln("WAITING FOR JDWP DATA....");
  //int* pjdwpdatalen = (int*)&buffer[0];
  //*pjdwpdatalen=0;
  retryread(fd, 4, function(err, data) {
    if (err) return terminate();

    var m = data.byteLength;
    if (m != 4) {
        dprintfln("rj %d len read", m);
        return terminate();
    }
    m = be2le(data.buffer.slice(0,4));
    //dprintfln("STARTING JDWP DATA: %.8x....", m);

    var lenstr = arrayBufferToString(data.buffer);

    retryreadfill(fd, m-4, function(err, data) {
      if (err) return terminate();

      var n = data.byteLength + 4;
      if (n != m) {
          dprintfln("rj read incomplete %d/%d", (n+4),m);
          return terminate();
      }
      //dprintfln("GOT JDWP DATA....");
      dprintfln("rj encoding %d bytes", n);
      var response = "rj ok ";
      response += btoa(lenstr + arrayBufferToString(data.buffer));

      si.ws.send(response);
      //dprintfln("SENT JDWP REPLY....");
      packets++;

      jdwpReplyMonitor(fd, si, packets);
    });
  });

  function terminate() {
    // try and send a final event reply indicating the VM has disconnected
      var vmdisconnect = [
            0,0,0,17, // len
            100,100,100,100, // id
            0, //flags
            0x40,0x64, // errcode = composite event
            0, //suspend
            0,0,0,1, // eventcount
            100, // eventkind=VM_DISCONNECTED
        ];
        var response = "rj ok ";
        response += btoa(ab2str(new Uint8Array(vmdisconnect)));
        si.ws.send(response);
        dprintfln("jdwpReplyMonitor thread finished. Sent:%d packets.", packets);
  }
}


var stdoutMonitor = function(fd, si, packets) {
  if (!packets) {
    packets = 0;
    dprintfln("stdoutMonitor thread started. jdwpfd:%d, wsfd:%o.", fd.n, si);
  }

  retryread(fd, function(err, data) {
    if (err) return terminate();
    var response  = 'so ok '+btoa(ab2str(new Uint8Array(data)));
    si.ws.send(response);
    packets++;

    stdoutMonitor(fd, si, packets);
  });

  function terminate() {
    // send a unique terminating string to indicate the stdout monitor has finished
	var eoso = "eoso:d10d9798-1351-11e5-bdd9-5b316631f026";
	var response = "so ok " + btoa(eoso);
    si.ws.send(response);
    dprintfln("stdoutMonitor thread finished. Sent:%d packets.", packets);
  }
}

// commands are:
// cn - create adb socket
// cp <port> - create custom-port socket
// wa <fd> <base64cmd> - write_adb_command
// rs <fd> [extra] - read_adb_status
// ra <fd> - read_adb_reply
// rj <fd> - read jdwp-formatted reply
// rx <fd> <len> - read raw data from adb socket
// wx <fd> <base64data> - write raw data to adb socket
// dc <fd|all> - disconnect adb sockets

var proxy_command_fns = {
  cn:function(si, e) {
    // create adb socket
    socket_loopback_client(si.wsServer.adbport, function(fd) {
      if (!fd) {
        return end_of_command(si, 'cn error connection failed');
      }
      si.fdarr.push(fd);
      return end_of_command(si, 'cn ok %d', fd.n);
    });
  },

  cp:function(si, e) {
    var x = e.data.split(' '), port;
    port = parseInt(x[1], 10);
    connect_forward_listener(port, {create:true}, function(sfd) {
      return end_of_command(si, 'cp ok %d', sfd.n);
    });
  },

  wa:function(si, e) {
    var x = e.data.split(' '), fd, buffer;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
      buffer = atob(x[2]);
    } catch(err) {
      return end_of_command(si, 'wa error wrong parameters');
    }
    write_adb_command(fd, buffer);
    return end_of_command(si, 'wa ok');
  },

  // rs fd [extra]
  rs:function(si, e) {
    var x = e.data.split(' '), fd, extra;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
      // optional additional bytes - used for sync-responses which
      // send status+length as 8 bytes
      extra = parseInt(atob(x[2]||'MA=='));
    } catch(err) {
      return end_of_command(si, 'rs error wrong parameters');
    }
    read_adb_status(fd, extra, function(status) {
      return end_of_command(si, 'rs ok %s', status||'');
    })
  },

  ra:function(si, e) {
    var x = e.data.split(' '), fd;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
    } catch(err) {
      return end_of_command(si, 'ra error wrong parameters');
    }
    read_adb_reply(fd, true, function(b64adbreply) {
      if (!b64adbreply) {
        return end_of_command('ra error read failed');
      }
      return end_of_command(si, 'ra ok %s', b64adbreply);
    });
  },

  rj:function(si, e) {
    var x = e.data.split(' '), fd;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
    } catch(err) {
      return end_of_command(si, 'rj error wrong parameters');
    }
    jdwpReplyMonitor(fd, si);
    return end_of_command(si, 'rj ok');
  },

  rx:function(si, e) {
    var x = e.data.split(' '), fd;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
    } catch(err) {
      return end_of_command(si, 'rx error wrong parameters');
    }
    if (fd.isSocket) {
      fd.readbytes(doneread);
    } else {
      fd.readbytes(fd.readpipe.byteLength, doneread);
    }
    function doneread(err, data) {
      if (err) {
        return end_of_command(si, 'rx ok nomore');
      }
      end_of_command(si, 'rx ok ' + btoa(ab2str(data)));
    }
  },

  so:function(si, e) {
    var x = e.data.split(' '), fd;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
    } catch(err) {
      return end_of_command(si, 'so error wrong parameters');
    }
    stdoutMonitor(fd, si);
    return end_of_command(si, 'so ok');
  },

  wx:function(si, e) {
    var x = e.data.split(' '), fd, buffer;
    try {
      var fdn = parseInt(x[1], 10);
      fd = fdn_to_fd(fdn);
      buffer = atob(x[2]);
    } catch(err) {
      return end_of_command(si, 'wx error wrong parameters');
    }

    fd.writebytes(str2u8arr(buffer), function(err) {
      if (err) 
        return end_of_command(si, 'wx error device write failed');
      end_of_command(si, 'wx ok');
    });
  },

  dc:function(si, e) {
    var x = e.data.split(' ');
    if (x[1] === 'all') {
      while (si.fdarr.length) {
        si.fdarr.pop().close();
      }
      return end_of_command(si, 'dc ok');
    }

    var n = parseInt(x[1],10);
    for (var i=0; i < si.fdarr.length; i++) {
      if (si.fdarr[i].n === n) {
        var fd = si.fdarr.splice(i,1)[0];
        fd.close();
        break;
      }
    }    
    return end_of_command(si, 'dc ok');
  }

}

exports.proxy = proxy;
