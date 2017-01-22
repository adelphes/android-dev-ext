const chrome = require('./chrome-polyfill').chrome;
const { new_socketfd } = require('./sockets');
const { create_chrome_socket, accept_chrome_socket, destroy_chrome_socket } = chrome;

var start_request = function(fd) {

    if (fd.closeState) return;

    // read service passed from client
    D('waiting for adb request...');
    readx_with_data(fd, function(err, data) {
        if (err) {
            D('SS: error %o', err);
            return;
        }
        handle_request(fd, data.asString());
        start_request(fd);
    });
}

var handle_request = exports.handle_request = function(fd, service) {
    if (!service){
        D('SS: no service');
        sendfailmsg(fd, 'No service received');
        return false;
    }
    D('adb request: %s', service);

    if (service.slice(0,4) === 'host') {
        // trim 'host:'
        return handle_host_request(service.slice(5), 'kTransportAny', null, fd);
    }

    if (!fd.transport) {
        D('No transport configured - using any found');
        var t = acquire_one_transport('CS_DEVICE', 'kTransportAny', null);
        t = check_one_transport(t, '', fd);
        if (!t) return false;
        fd.transport = t;
    }

    // once we call open_device_service, the fd belongs to the transport
    open_device_service(fd.transport, fd, service, function(err, serviceinfo) {
        if (err) {
            sendfailmsg(fd, 'Device connection failed');
            return;
        }
        D('device service opened: %o', serviceinfo);
        send_okay(fd);
    });
    return true;
}

var sendfailmsg = function(fd, reason) {
    reason = reason.slice(0, 0xffff);
    var msg = 'FAIL' + intToHex(reason.length,4) + reason;
    writex(fd, msg);
}

var handle_host_request = function(service, ttype, serial, replyfd) {
    var transport;

    if (service === 'kill') {
        cl('service kill request');
        send_okay(replyfd);
        killall_devices();
        //window.close();
        return false;
    }

    if (service.slice(0,9) === 'transport') {
        var t,serialmatch;
        switch(service.slice(9)) {
            case '-any': 
                t = acquire_one_transport('CS_ANY','kTransportAny',null);
                break;
            case '-local':
                t = acquire_one_transport('CS_ANY','kTransportLocal',null);
                break;
            case '-usb':
                t = acquire_one_transport('CS_ANY','kTransportUsb',null);
                break;
            default:
                if (serialmatch = service.slice(9).match(/^:(.+)/))
                    t = acquire_one_transport('CS_ANY','kTransportAny',serialmatch[1]);
                break;
        }
        t = check_one_transport(t, serialmatch&&serialmatch[1], replyfd);
        if (!t) return false;

        // set the transport in the fd - the client can use it
        // to send raw data directly to the device
        D('transport configured: %o', t);
        replyfd.transport = t;
        adb_writebytes(replyfd, "OKAY");
        return false;
    }

    if (service.slice(0,7) === 'devices') {
        var use_long = service.slice(7)==='-l';
        D('Getting device list');
        var transports = list_transports(use_long);
        D('Wrote device list');
        send_msg_with_okay(replyfd, transports);
        return false;
    }

    if (service === 'version') {
        var version = intToHex(ADB_SERVER_VERSION, 4);
        send_msg_with_okay(replyfd, version);
        return false;
    }

    if (service.slice(0,9) === 'emulator:') {
        var port = service.slice(9);
        port = port&&parseInt(port, 10)||0;
        if (!port || port <= 0 || port >= 65536) {
          D('Invalid emulator port: %s', service);
          return false;
        }
        local_connect(port, function(err) {

        });
        // no reply needed
        return false;
    }

    if (service.slice(0,9) === 'get-state') {
        transport = acquire_one_transport('CS_ANY', ttype, serial, null);
        transport = check_one_transport(transport, serial, replyfd);
        if (!transport) return false;
        var state = connection_state_name(transport);
        send_msg_with_okay(replyfd, state);
        return false;
    }

    if (service === 'killforward-all') {
        remove_all_forward_listeners();
        writex(replyfd, 'OKAY');
        return false;
    }

    var fwdmatch = service.match(/^forward:(tcp:\d+);(jdwp:\d+)/);
    if (fwdmatch) {
        transport = acquire_one_transport('CS_ANY', ttype, serial, null);
        transport = check_one_transport(transport, serial, replyfd);
        if (!transport) return false;

        install_forward_listener(fwdmatch[1], fwdmatch[2], transport, function(err) {
            if (err) return sendfailmsg(replyfd, err.msg);
            // on the host, 1st OKAY is connect, 2nd OKAY is status
            writex(replyfd, 'OKAY');
            writex(replyfd, 'OKAY');
        });
        return false;
    }

    if (service === 'track-devices') {
        writex(replyfd, 'OKAY');
        add_device_tracker(replyfd);
        // fd now belongs to the tracker
        return true;
    }

    if (service === 'track-devices-extended') {
        writex(replyfd, 'OKAY');
        add_device_tracker(replyfd, true);
        // fd now belongs to the tracker
        return true;
    }

    cl('Ignoring host service request: %s', service);
    return false;
}

var check_one_transport = function(t, serial, replyfd) {
    var which = serial||'(null)';
    switch((t||[]).length) {
        case 0:
            sendfailmsg(replyfd, "device '"+which+"' not found");
            return null;
        case 1: t = t[0];
            break;
        default:
            sendfailmsg(replyfd, 'more than one device/emulator');
            return null;
    }
    switch(t.connection_state) {
        case 'CS_DEVICE': break;
        case 'CS_UNAUTHORIZED':
            sendfailmsg(replyfd, 'device unauthorized.\r\nCheck for a confirmation dialog on your device or reconnect the device.');
            return null;
        default:
            sendfailmsg(replyfd, 'Device not ready');
            return null;
    }
    return t;
}

var forward_listeners = {};

var install_forward_listener = function(local, remote, t, cb) {
    var localport = parseInt(local.split(':').pop(), 10);

    var socket = chrome.socket;

    create_chrome_socket('forward listener:'+localport, function(socketInfo) {
        if (chrome.runtime.lastError) {
            return cb({msg:chrome.runtime.lastError.message||'socket creation failed'});
        }
        socket.listen(socketInfo.socketId, '127.0.0.1', localport, 5,
            function(result) {
                if (chrome.runtime.lastError) {
                    var err = {msg:chrome.runtime.lastError.message||'socket listen failed'};
                    destroy_setup(socketInfo);
                    return cb(err);
                }
                if (result < 0) {
                    destroy_setup(socketInfo);
                    return cb({msg:'Cannot bind to socket'});
                }
                 
                forward_listeners[localport] = {
                    port:localport,
                    socketId: socketInfo.socketId,
                    connectors_fd: null,
                    connect_cb:function(){},
                };

                accept_chrome_socket('forward server:'+localport, socketInfo.socketId, function(acceptInfo) {
                    accept_forward_connection(socketInfo.socketId, acceptInfo, localport, local, remote, t);
                });

                // listener is ready
                D('started forward listener on port %d: %d', localport, socketInfo.socketId);
                cb();
            }
        );
    });

    function destroy_setup(socketInfo) {
        destroy_chrome_socket(socketInfo.socketId);
    }
}

var connect_forward_listener = exports.connect_forward_listener = function(port, opts, cb) {

    // if we're implementing the adb service, this will already be created
    // if we're connecting via the adb executable, we need to create a dummy entry
    if (!forward_listeners[port]) {
        if (opts && opts.create) {
            forward_listeners[port] = {
                is_external_adb: true,
                port:port,
                socketId: null,
                connectors_fd: null,
                connect_cb:function(){},
            }
        } else {
            D('Refusing forward connection request - forwarder for port %d does not exist', port);
            return cb();
        }
    }

    create_chrome_socket('forward client:'+port, function(createInfo) {
        // save the receiver info
        forward_listeners[port].connectors_fd = new_socketfd(createInfo.socketId);
        forward_listeners[port].connect_cb = cb;

        // do the connect - everything from here on is handled in the accept routine
        chrome.socket.connect(createInfo.socketId, '127.0.0.1', port, function(result) {
            chrome.socket.setNoDelay(createInfo.socketId, true, function(result) {
                var x = forward_listeners[port];
                if (x.is_external_adb) {
                    delete forward_listeners[port];
                    x.connect_cb(x.connectors_fd);
                }
            });
        });
    });
}

var accept_forward_connection = exports.accept_forward_connection = function(listenerSocketId, acceptInfo, port, local, remote, t) {
    if (chrome.runtime.lastError) {
        D('Forward port socket accept failed: '+port);
        var listener = remove_forward_listener(listenerSocketId);
        return listener.connect_cb();
    }

    // on accept - create the remote connection to the device
    D('Binding forward port connection to remote port %s', remote);
    var sfd = new_socketfd(acceptInfo.socketId);

    // remove the listener
    var listener = remove_forward_listener(listenerSocketId);

    chrome.socket.setNoDelay(acceptInfo.socketId, true, function(result) {
        // start the connection as a service
        open_device_service(t, sfd, remote, function(err) {
            listener.connect_cb(listener.connectors_fd);
        });
    });
}

var remove_forward_listener = exports.remove_forward_listener = function(socketId) {
    for (var port in forward_listeners) {
        if (forward_listeners[port].socketId === socketId) {
            var x = forward_listeners[port];
            delete forward_listeners[port];
            destroy_chrome_socket(x.socketId);
            D('removed forward listener: %d', x.socketId);
            return x;
        }
    }
}

var remove_all_forward_listeners = exports.remove_all_forward_listeners = function() {
    var ports = Object.keys(forward_listeners);
    while (ports.length) {
        remove_forward_listener(forward_listeners[ports.pop()].socketId);
    }
}