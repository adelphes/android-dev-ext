const net = require('net');
const EventEmitter = require('events');

/**
 * Common socket class for ADBSocket and JDWPSocket
 */
class AndroidSocket extends EventEmitter {
    constructor(which) {
        super()
        this.which = which;
        this.socket = null;
        this.socket_error = null;
        this.socket_ended = false;
        this.readbuffer = Buffer.alloc(0);
    }

    connect(port, hostname) {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                return reject(new Error(`${this.which} Socket connect failed. Socket already connected.`));
            }
            const connection_error = err => {
                return reject(new Error(`${this.which} Socket connect failed. ${err.message}.`));
            }
            const post_connection_error = err => {
                this.socket_error = err;
                this.socket.end();
            }
            let error_handler = connection_error;
            this.socket = new net.Socket()
                .once('connect', () => {
                    error_handler = post_connection_error;
                    this.socket
                        .on('data', buffer => {
                            this.readbuffer = Buffer.concat([this.readbuffer, buffer]);
                            this.emit('data-changed');
                        })
                        .once('end', () => {
                            this.socket_ended = true;
                            this.emit('data-changed');
                            this.emit('socket-ended');
                            if (!this.socket_disconnecting) {
                                this.socket_disconnecting = this.socket_error ? Promise.reject(this.socket_error) : Promise.resolve();
                            }
                        });
                    resolve();
                })
                .on('error', err => error_handler(err));
            this.socket.connect(port, hostname);
        });
    }

    disconnect() {
        if (!this.socket_disconnecting) {
            this.socket_disconnecting = new Promise(resolve => {
                this.socket.end();
                this.socket = null;
                this.once('socket-ended', resolve);
            });
        }
        return this.socket_disconnecting;
    }

    async read_bytes(length, format) {
        //D(`reading ${length} bytes`);
        let actual_length = length;
        if (typeof actual_length === 'undefined') {
            if (this.readbuffer.byteLength > 0 || this.socket_ended) {
                actual_length = this.readbuffer.byteLength;
            }
        }
        if (actual_length < 0) {
            return Promise.reject(new Error(`${this.which} socket read failed. Attempt to read ${actual_length} bytes.`));
        }
        if (length === 'length+data' && this.readbuffer.byteLength >= 4) {
            length = actual_length = this.readbuffer.readUInt32BE(0);
        }
        // do we have enough data in the buffer?
        if (this.readbuffer.byteLength >= actual_length) {
            //D(`got ${actual_length} bytes`);
            let data = this.readbuffer.slice(0, actual_length);
            this.readbuffer = this.readbuffer.slice(actual_length);
            if (format) {
                data = data.toString(format);
            }
            return Promise.resolve(data);
        }
        if (this.socket_ended) {
            return Promise.reject(new Error(`${this.which} socket read failed. Socket closed.`));
        }
        // wait for the data-changed event and then retry the read
        //D(`waiting for ${length} bytes`);
        await new Promise(resolve => this.once('data-changed', resolve));
        return this.read_bytes(length, format);
    }

    async read_le_length_data(format) {
        const len = await this.read_bytes(4);
        return this.read_bytes(len.readUInt32LE(0), format);
    }

    read_stdout(format = 'latin1') {
        return this.read_bytes(undefined, format);
    }

    /**
     * Writes a raw command to the socket
     * @param {string} command 
     */
    write_bytes(bytes) {
        if (this.socket_ended) {
            return Promise.reject(new Error(`${this.which} socket write failed. Socket closed.`));
        }
        return new Promise((resolve, reject) => {
            try {
                const flushed = this.socket.write(bytes, () => {
                    flushed ? resolve() : this.socket.once('drain', resolve);
                });
            } catch (e) {
                this.socket_error = e;
                reject(new Error(`${this.which} socket write failed. ${e.message}`));
            }
        });
    }
}

module.exports = AndroidSocket;
