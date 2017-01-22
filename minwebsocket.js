/*
    A dummy websocket implementation for passing messages internally using a WS-like protocol
*/
var Servers = {};

function isfn(x) { return typeof(x) === 'function' }

function WebSocketClient(url) {
    // we only support localhost addresses in this implementation
    var match = url.match(/^ws:\/\/127\.0\.0\.1:(\d+)$/);
    var port = match && parseInt(match[1],10);
    if (!port || port <= 0 || port >= 65536)
        throw new Error('Invalid websocket url');
    var server = Servers[port];
    if (!server) throw new Error('Connection refused'); // 'port' already in use :)
    server.addClient(this);
    this._ws = {
        port: port,
        server: server,
        outgoing:[],
    };
}

WebSocketClient.prototype.send = function(message) {
    this._ws.outgoing.push(message);
    if (this._ws.outgoing.length > 1) return;
    process.nextTick(function(client) {
        if (!client || !client._ws || !client._ws.server)
            return;
        client._ws.server.receive(client, client._ws.outgoing);
        client._ws.outgoing = [];
    }, this);
}

WebSocketClient.prototype.receive = function(messages) {
    if (isfn(this.onmessage))
        messages.forEach(m => {
            this.onmessage({
                data:m
            });
        });
}

WebSocketClient.prototype.close = function() {
    process.nextTick(() => {
        this._ws.server.rmClient(this);
        this._ws.server = null;
        if (isfn(this.onclose))
            this.onclose(this);
        this._ws = null;
    });
}



function WebSocketServer(port) {
    if (typeof(port) !== 'number' || port <= 0 || port >= 65536)
        throw new Error('Invalid websocket server port');
    if (Servers[''+port]) 
        throw new Error('Address in use');
    this.port = port;
    this.clients = [];
    Servers[''+port] = this;
}

WebSocketServer.prototype.addClient = function(client) {
    var status;
    this.clients.push(status = {
        server:this,
        client: client,
        onmessage:null,
        onclose:null,
        outgoing:[],
        send: function(message) {
            this.outgoing.push(message);
            if (this.outgoing.length > 1) return;
            process.nextTick(function(status) {
                if (!status || !status.client)
                    return;
                status.client.receive(status.outgoing);
                status.outgoing = [];
            }, this);
        }
    });
    process.nextTick((status) => {
        if (isfn(this.onconnection))
            this.onconnection({
                status: status,
                accept:function() {
                    process.nextTick((status) => {
                        if (isfn(status.client.onopen))
                            status.client.onopen(status.client);
                    }, this.status);
                    return this.status;
                }
            });
    }, status);
}

WebSocketServer.prototype.rmClient = function(client) {
    for (var i = this.clients.length-1; i >= 0; --i) {
        if (this.clients[i].client === client) {
            if (isfn(this.clients[i].onclose))
                this.clients[i].onclose();
            this.clients.splice(i, 1);
        }
    }
}

WebSocketServer.prototype.receive = function(client, messages) {
    var status = this.clients.filter(c => c.client === client)[0];
    if (!status) return;
    if (!isfn(status.onmessage)) return;
    messages.forEach(m => {
        status.onmessage({
            data: m,
        });
    });
}

exports.WebSocketClient = WebSocketClient;
exports.WebSocketServer = WebSocketServer;
