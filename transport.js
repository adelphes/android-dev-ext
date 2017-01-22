const D = function(){};// require('./util').D;

var transport_list = [];
var next_connect_device_service_id = 1;

var open_device_service = exports.open_device_service = function(t, fd, service, cb) {
    D('open_device_service %s on device %s', service, t.serial);

    var p = get_apacket();
    p.msg.command = A_OPEN;
    p.msg.arg0 = ++next_connect_device_service_id;
    p.msg.data_length = service.length+1;
    p.data.set(str2u8arr(service));

    var serviceinfo = {
        service: service,
        transport: t,
        localid: p.msg.arg0,
        remoteid: 0,
        state: 'init',
        nextokay:null,
        nextwrte:null,
        nextclse:on_device_close_reply,
        clientfd: fd,
        isjdwp: /^jdwp\:\d+/.test(service),
        islogcat: /^(shell:)?logcat/.test(service),
    };
    t.open_services.push(serviceinfo);

    serviceinfo.nextokay = on_device_open_okay;
    serviceinfo.state = 'talking';
    send_packet(p, t, function(err) {
        if (err) {
            serviceinfo.state = 'init-error';
            remove_device_service(serviceinfo);
            return cb(err);
        }
    });

    function ignore_response(err, p, serviceinfo, receivecb) {
        D('ignore_response, p=%o', p);
        receivecb();
    }

    function on_device_open_okay(err, p, serviceinfo, receivecb) {
        D('on_device_open_okay: %s, err:%o', serviceinfo.service, err);
        if (err) {
            receivecb();
            cb(err);
            return;
        }
        serviceinfo.state = 'ready';
        serviceinfo.nextokay = ignore_response;
        serviceinfo.nextwrte = on_device_write_reply;

        // ack the packet receive callback
        receivecb();
        // ack the open_device_service callback
        cb(null, serviceinfo);

        // start reading from the client
        read_from_client(serviceinfo);
    }

    function read_from_client(serviceinfo) {
        D('Waiting for client data');
        serviceinfo.clientfd.readbytes(function(err, data) {
            if (err) {
                // read error - the client probably closed the connection
                send_close_device_service(serviceinfo, function(err) {
                    remove_device_service(serviceinfo);
                });
                return;
            }
            D('client WRTE %d bytes to device', data.byteLength);
            // send the data to the device
            var p = get_apacket();
            p.msg.command = A_WRTE;
            p.msg.arg0 = serviceinfo.localid;
            p.msg.arg1 = serviceinfo.remoteid;
            p.msg.data_length = data.byteLength;
            p.data.set(data);
            if (serviceinfo.isjdwp) 
                print_jdwp_data('out',data);

            serviceinfo.nextokay = function(err, p, serviceinfo, receivecb) {
                if (err) {
                    // if we fail to write, just abort
                    remove_device_service(serviceinfo);
                    receivecb();
                    return;
                }
                D('client WRTE - got OKAY');
                serviceinfo.nextokay = ignore_response;
                receivecb();
                // read and send more
                read_from_client(serviceinfo);
            }

            send_packet(p, t, function(err) {
                if (err) {
                    // if we fail to write, just abort
                    remove_device_service(serviceinfo);
                    return;
                }
                // we must wait until the next OKAY until we can write more
                D('client WRTE - waiting for OKAY');
            });
        });
    }

    function on_device_write_reply(err, p, serviceinfo, receivecb) {
        D('device WRTE received');
        if (err) {
            serviceinfo.state = 'write reply error';
            remove_device_service(serviceinfo);
            receivecb();
            return;
        };

        // when we receive a WRTE, we must reply with an OKAY as the very next packet.
        // - we can't wait for the data to be forwarded because the reader might post
        // something in between
        D('sending OKAY');
        send_ready(serviceinfo.localid, serviceinfo.remoteid, serviceinfo.transport, function(err){
            if (err) {
                serviceinfo.state = 'write okay error';
                remove_device_service(serviceinfo);
                return;
            }
            D('sent OKAY');
        });

        if (serviceinfo.isjdwp)
            print_jdwp_data('dev', p.data);

        // write the data to the client
        serviceinfo.clientfd.writebytes(new Uint8Array(p.data.buffer.slice(0, p.msg.data_length)), function(err) {
            // ack the packet receive callback
            receivecb();
        });
    }

    function on_device_close_reply(err, p, serviceinfo, receivecb) {
        var t = serviceinfo.transport;
        D('on_device_close_reply %s (by device) on device %s', serviceinfo.service, t.serial);
        serviceinfo.state = 'closed (by device)';
        remove_device_service(serviceinfo);
        // ack the packet receive callback
        receivecb();
    }

}

var find_open_device_service = exports.find_open_device_service = function(t, localid, remoteid) {
    for (var i=0; i < t.open_services.length; i++) {
        var s = t.open_services[i];
        if (s.localid === localid && (!remoteid ||(s.remoteid === remoteid))) {
            return s;
        }
    }
    return null;
}

var send_close_device_service = exports.send_close_device_service = function(serviceinfo, cb) {
    D('send_close_device_service: %s, device:%s', serviceinfo.service, serviceinfo.transport.serial);
    var p = get_apacket();

    p.msg.command = A_CLSE;
    p.msg.arg0 = serviceinfo.localid;
    p.msg.arg1 = serviceinfo.remoteid;

    serviceinfo.nextreply = on_close_request_reply;
    serviceinfo.state = 'talking';
    send_packet(p, serviceinfo.transport, function(err) {
        if (err) {
            serviceinfo.state = 'error';
        } else {
            serviceinfo.state = 'closed';
        }
        // ack the close_device_service request as soon as we
        // send the packet - don't wait for the reply
        return cb(err);
    });

    function on_close_request_reply(which, serviceinfo, receivecb) {
        // ack the packet receive callback
        receivecb();
    }
}

var remove_device_service = exports.remove_device_service = function(serviceinfo) {
    var fd;
    if (fd=serviceinfo.clientfd) {
        serviceinfo.clientfd=null;
        fd.close();
    }
    remove_from_list(serviceinfo.transport.open_services, serviceinfo);
}

var register_transport = exports.register_transport = function(t, cb) {
    t.terminated = false;
    t.open_services = [];
    transport_list.push(t);

    // start the reader
    function read_next_packet_from_transport(t, packetcount) {
        var p = new_apacket();
        t.read_from_remote(p, t, function(err, p) {
            if (t.terminated) {
                return;
            }
            if (err) {
                D('Error reading next packet from transport:%s - terminating.', t.serial);
                kick_transport(t);
                unregister_transport(t);
                return;
            }
            p.which = intToCharString(p.msg.command);
            D('Read packet:%d (%s) from transport:%s', packetcount, p.which, t.serial);
            var pc = packetcount++;
            handle_packet(p, t, function(err) {
                D('packet:%d handled, err:%o', pc, err);
                read_next_packet_from_transport(t, packetcount);
            });
        });
    }
    read_next_packet_from_transport(t, 0);

    D("transport: %s registered\n", t.serial);
    D('new transport list: %o', transport_list.slice());
    update_transports();

    ui.update_device_property(t.deviceinfo, 'status', 'Connecting...');
    send_connect(t, cb);
}

var unregister_transport = exports.unregister_transport = function(t) {
    if (t.fd)
        t.fd.close();
    // kill any connected services
    while (t.open_services.length) {
        remove_device_service(t.open_services.pop());
    }

    remove_from_list(transport_list, t);
    D("transport: %s unregistered\n", t.serial);
    D('remaining transports: %o', transport_list.slice());
    t.serial = 'REMOVED:' + t.serial;
    t.terminated = true;
    update_transports();
    ui.update_device_property(t.deviceinfo, 'status', 'Disconnected', '#8B0E0E');
    ui.remove_disconnected_device(t.deviceinfo);
}

var kick_transport = exports.kick_transport = function(t) {
    if (t && !t.kicked) {
        t.kicked = true;
        t.kick(t);
    }
}

var write_packet_to_transport = exports.write_packet_to_transport = function(t, p, cb) {
    if (t.terminated) {
        D('Refusing to write packet to terminated transport: %s', t.serial);
        return cb({msg:'device not found'});
    }
    t.write_to_remote(p, t, function(err) {
        cb(err);
    });
}

var send_packet = exports.send_packet = function(p, t, cb) {
    p.msg.magic = p.msg.command ^ 0xffffffff;

    var count = p.msg.data_length;
    var x = new Uint8Array(p.data);
    var sum = 0, i=0;
     while(count-- > 0){
         sum += x[i++];
     }
     p.msg.data_check = sum;
 
     write_packet_to_transport(t, p, cb);
}

var acquire_one_transport = exports.acquire_one_transport = function(connection_state, transport_type, serial) {
    var candidates = [];
    for (var i=0, tl=transport_list; i < tl.length; i++) {
        if (connection_state !== 'CS_ANY' && tl[i].connection_state !== connection_state)
            continue;
        if (transport_type !== 'kTransportAny' && tl[i].transport_type !== transport_type)
            continue;
        if (serial && tl[i].serial !== serial)
            continue;
        candidates.push(tl[i]);
    }
    return candidates;
}

var statename = exports.statename = function(t) {
    if (/^CS_.+/.test(t.connection_state))
        return t.connection_state.slice(3).toLowerCase();
    return 'unknown state: ' + t.connection_state;
}

var typename = exports.typename = function(t) {
    if (/^kTransport.+/.test(t.type))
        return t.type.slice(10).toLowerCase();
    return 'unknown type: ' + t.type;
}

var format_transport = exports.format_transport = function(t, format) {
    var serial = t.serial || '???????????';

    if (!format) {
        return serial+'\t'+statename(t);
    } else if (format === 'extended') {
        return '{'+[
            '"device":'+JSON.stringify(t.device),
            '"model":'+JSON.stringify(t.model||t.deviceinfo.productName),
            '"product":'+JSON.stringify(t.product),
            '"serial":'+JSON.stringify(serial),
            '"status":'+JSON.stringify(statename(t)),
            '"type":'+JSON.stringify(typename(t)),
        ].join(',') + '}';
    } else {
        return [
            serial+'\t'+statename(t),
            t.devpath||'',
            t.product?'product:'+t.product.replace(/\s+/,'_'):'',
            t.model?'model:'+t.model.replace(/\s+/,'_'):'',
            t.device?'device:'+t.device.replace(/\s+/,'_'):''
            ].join(' ');
    }
}

var list_transports = exports.list_transports = function(format) {
    return transport_list.map(function(t) {
        return format_transport(t, format);
    }).join('\n')+'\n';
}

var update_transports = exports.update_transports = function() {
    write_transports_to_trackers(_device_trackers.normal);
    write_transports_to_trackers(_device_trackers.extended, null, true);
}

var readx_with_data = exports.readx_with_data = function(fd, cb) {
    readx(fd, 4, function(err, buf) {
        if (err) return cb(err);
        var dlen = buf.intFromHex();
        if (dlen < 0 || dlen > 0xffff)
           return cb({msg:'Invalid data len: ' + dlen});
        readx(fd, dlen, function(err, buf) {
            if (err) return cb(err);
            return cb(null, buf);
        });
    });
}

var readx = exports.readx = function(fd, len, cb) {
    D('readx: fd:%o wanted=%d', fd, len);
    fd.readbytes(len, function(err, buf) {
        if (err) return cb(err);
        cb(err, buf);
    });
}

var writex = exports.writex = function(fd, bytes, len) {
    if (typeof(bytes) === 'string') {
        var buf = new Uint8Array(bytes.length);
        for (var i=0; i < bytes.length; i++)
            buf[i] = bytes.charCodeAt(i);
        bytes = buf;
    }
    if (typeof(len) !== 'number')
        len = bytes.byteLength;
    D('writex: fd:%o writing=%d', fd, len);
    fd.writebytes(bytes.subarray(0,len));
}

var writex_with_data = exports.writex_with_data = function(fd, data, len) {
    if (typeof(len) === 'undefined');
        len = data.byteLength||data.length||0;
    writex(fd, intToHex(len, 4));
    writex(fd, data, len);
}

var _device_trackers = {
    normal:[],
    extended:[],
}
var add_device_tracker = exports.add_device_tracker = function(fd, extended) {
    _device_trackers[extended?'extended':'normal'].push(fd);
    write_transports_to_trackers([fd], null, extended);
    readtracker(fd, extended);
    D('Device tracker added. Trackers: %o', _device_trackers);

    function readtracker(fd, extended) {
        chrome.socket.read(fd.n, function(readInfo) {
            if (chrome.runtime.lastError || readInfo.resultCode < 0) {
                remove_from_list(_device_trackers[extended?'extended':'normal'], fd);
                D('Device tracker socket read failed - closing.  Trackers: %o', _device_trackers);
                fd.close();
                return;
            }
            D('Ignoring data read from device tracker socket');
            readtracker(fd, extended);
        });
    }
}

var write_transports_to_trackers = exports.write_transports_to_trackers = function(fds, transports, extended) {
    if (!fds || !fds.length)
        return;
    if (!transports) {
        return write_transports_to_trackers(fds, list_transports(extended?'extended':''), extended);
    }
    D('Writing transports: %s', transports);
    fds.slice().forEach(function(fd) {
        writex_with_data(fd, str2u8arr(transports));
    });
}
